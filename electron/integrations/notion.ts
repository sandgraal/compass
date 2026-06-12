/**
 * Notion import — Phase 7 Track B (the cloud half of "Notion + Obsidian").
 *
 * Reads every page the user has SHARED with their Notion internal
 * integration (https://www.notion.so/my-integrations — a paste-once token,
 * no OAuth app) and mirrors it as markdown under `knowledge-base/notion/`.
 * One-way import, same dedicated-namespace + prune semantics as the
 * Obsidian bridge: everything under `notion/` is Compass-managed.
 *
 * Privacy posture: the token is encrypted via the standard `saveToken`
 * path; only pages explicitly shared with the integration are visible to
 * the API at all (Notion's own permission model is the consent surface).
 * Export (Compass → Notion) is a planned follow-up — see the plan doc.
 *
 * Sync cost control: each page's `last_edited_time` is stamped into the
 * file's frontmatter; unchanged pages skip the (paginated, recursive)
 * block fetch entirely on subsequent syncs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { integrations, syncEvents } from '../db/schema'
import { loadToken } from '../ipc/auth'
import { KNOWLEDGE_DIR } from '../paths'

export const NOTION_API = 'https://api.notion.com/v1'
export const NOTION_VERSION = '2022-06-28'
/** Knowledge-base subdirectory that receives the import (Compass-managed). */
export const NOTION_IMPORT_SUBDIR = 'notion'
/** Hard cap on pages per sync — keeps a huge workspace from hanging a sync. */
const MAX_PAGES = 200
/** Block-children recursion depth cap (toggles inside toggles inside…). */
const MAX_BLOCK_DEPTH = 3

// ── Minimal structural types (we only touch these fields) ───────────────────

export interface NotionRichText {
  plain_text: string
  href?: string | null
  annotations?: {
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    code?: boolean
  }
}

export interface NotionBlock {
  id: string
  type: string
  has_children?: boolean
  /** Attached by fetchBlockTree so rendering can stay pure. */
  children?: NotionBlock[]
  // Per-type payload lives under the type key, e.g. block.paragraph.rich_text.
  [key: string]: unknown
}

export interface NotionPage {
  id: string
  url?: string
  last_edited_time: string
  properties?: Record<string, { type?: string; title?: NotionRichText[] }>
}

// ── Markdown rendering (pure) ────────────────────────────────────────────────

export function richTextToMarkdown(rt: NotionRichText[] | undefined): string {
  if (!rt?.length) return ''
  return rt
    .map((t) => {
      let s = t.plain_text
      const a = t.annotations ?? {}
      if (a.code) s = `\`${s}\``
      if (a.bold) s = `**${s}**`
      if (a.italic) s = `*${s}*`
      if (a.strikethrough) s = `~~${s}~~`
      if (t.href) s = `[${s}](${t.href})`
      return s
    })
    .join('')
}

function blockText(block: NotionBlock): string {
  const payload = block[block.type] as { rich_text?: NotionRichText[] } | undefined
  return richTextToMarkdown(payload?.rich_text)
}

/**
 * Renders an already-assembled block tree (children attached) to markdown
 * lines. Unsupported block types are skipped silently — an import that
 * captures the prose is more useful than one that fails on a synced-database
 * view it can't represent.
 */
export function renderBlocks(blocks: NotionBlock[], indent = ''): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    const text = blockText(block)
    switch (block.type) {
      case 'heading_1':
        lines.push(`${indent}# ${text}`, '')
        break
      case 'heading_2':
        lines.push(`${indent}## ${text}`, '')
        break
      case 'heading_3':
        lines.push(`${indent}### ${text}`, '')
        break
      case 'paragraph':
        lines.push(text ? `${indent}${text}` : '', ...(text ? [''] : []))
        break
      case 'bulleted_list_item':
      case 'toggle':
        lines.push(`${indent}- ${text}`)
        break
      case 'numbered_list_item':
        // Always "1." — markdown renderers renumber ordered lists.
        lines.push(`${indent}1. ${text}`)
        break
      case 'to_do': {
        const payload = block.to_do as { checked?: boolean } | undefined
        lines.push(`${indent}- [${payload?.checked ? 'x' : ' '}] ${text}`)
        break
      }
      case 'quote':
      case 'callout':
        lines.push(`${indent}> ${text}`, '')
        break
      case 'code': {
        const payload = block.code as { language?: string } | undefined
        lines.push(`${indent}\`\`\`${payload?.language ?? ''}`, text, `${indent}\`\`\``, '')
        break
      }
      case 'divider':
        lines.push(`${indent}---`, '')
        break
      case 'child_page': {
        const payload = block.child_page as { title?: string } | undefined
        lines.push(`${indent}- 📄 ${payload?.title ?? 'Untitled subpage'}`)
        break
      }
      case 'bookmark':
      case 'embed':
      case 'image': {
        const payload = block[block.type] as
          | { url?: string; external?: { url?: string } }
          | undefined
        const url = payload?.url ?? payload?.external?.url
        if (url) lines.push(`${indent}<${url}>`, '')
        break
      }
      default:
        // table / synced_block / column_list / database views etc. — skipped.
        break
    }
    if (block.children?.length) {
      // List-ish parents nest their children; everything else renders flat.
      const nests =
        block.type === 'bulleted_list_item' ||
        block.type === 'numbered_list_item' ||
        block.type === 'to_do' ||
        block.type === 'toggle'
      lines.push(...renderBlocks(block.children, nests ? `${indent}  ` : indent))
    }
  }
  return lines
}

export function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === 'title' && prop.title) {
      const t = prop.title.map((rt) => rt.plain_text).join('')
      if (t.trim()) return t.trim()
    }
  }
  return 'Untitled'
}

/**
 * Stable filename: slug + the first 8 hex of the page id, so two pages with
 * the same title don't collide and a rename just re-slugs (old file pruned).
 */
export function pageFileName(page: NotionPage): string {
  const slug =
    pageTitle(page)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  const id8 = page.id.replace(/-/g, '').slice(0, 8)
  return `${slug}-${id8}.md`
}

// ── API access ───────────────────────────────────────────────────────────────

async function notionFetch(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  if (resp.status === 401) {
    throw new Error('Notion rejected the token (401). Reconnect with a fresh integration token.')
  }
  if (!resp.ok) {
    throw new Error(`Notion API ${path} responded with HTTP ${resp.status}.`)
  }
  return (await resp.json()) as Record<string, unknown>
}

/** Every page shared with the integration, paginated, capped at MAX_PAGES. */
export async function listSharedPages(token: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = []
  let cursor: string | undefined
  do {
    const data = await notionFetch(token, 'POST', '/search', {
      filter: { property: 'object', value: 'page' },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    })
    pages.push(...((data.results as NotionPage[] | undefined) ?? []))
    cursor = data.has_more ? (data.next_cursor as string) : undefined
  } while (cursor && pages.length < MAX_PAGES)
  return pages.slice(0, MAX_PAGES)
}

/** Paginated children fetch + bounded recursion; returns a render-ready tree. */
export async function fetchBlockTree(
  token: string,
  blockId: string,
  depth = 0
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = []
  let cursor: string | undefined
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100'
    const data = await notionFetch(token, 'GET', `/blocks/${blockId}/children${qs}`)
    blocks.push(...((data.results as NotionBlock[] | undefined) ?? []))
    cursor = data.has_more ? (data.next_cursor as string) : undefined
  } while (cursor)

  if (depth < MAX_BLOCK_DEPTH) {
    for (const block of blocks) {
      if (block.has_children && block.type !== 'child_page') {
        block.children = await fetchBlockTree(token, block.id, depth + 1)
      }
    }
  }
  return blocks
}

// ── Sync ─────────────────────────────────────────────────────────────────────

const LAST_EDITED_RE = /^notion-last-edited: (.+)$/m

export function buildPageMarkdown(page: NotionPage, blocks: NotionBlock[]): string {
  const lines = [
    '---',
    'source: notion',
    `notion-id: ${page.id}`,
    ...(page.url ? [`notion-url: ${page.url}`] : []),
    `notion-last-edited: ${page.last_edited_time}`,
    '---',
    '',
    `# ${pageTitle(page)}`,
    '',
    ...renderBlocks(blocks)
  ]
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Full sync entry point — same integration-row + sync_events bookkeeping as
 * the Obsidian/Apple-Calendar pattern (insert-on-conflict on BOTH paths so a
 * first-ever failure still surfaces).
 */
export async function syncNotion(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('notion') as { access_token?: string } | null
  if (!tokens?.access_token) {
    return { service: 'notion', success: false, error: 'Not connected' }
  }
  const token = tokens.access_token
  const db = getDb()

  try {
    const importDir = join(KNOWLEDGE_DIR, NOTION_IMPORT_SUBDIR)
    if (!existsSync(importDir)) mkdirSync(importDir, { recursive: true })

    const pages = await listSharedPages(token)
    const expected = new Set<string>()
    let written = 0
    let skipped = 0

    for (const page of pages) {
      const fileName = pageFileName(page)
      expected.add(fileName)
      const filePath = join(importDir, fileName)
      // Unchanged since last import → skip the whole block fetch.
      if (existsSync(filePath)) {
        const prev = readFileSync(filePath, 'utf8')
        if (LAST_EDITED_RE.exec(prev)?.[1] === page.last_edited_time) {
          skipped++
          continue
        }
      }
      const blocks = await fetchBlockTree(token, page.id)
      writeFileSync(filePath, buildPageMarkdown(page, blocks), 'utf8')
      written++
    }

    // Prune files whose page is gone / no longer shared. `notion/` is a
    // dedicated Compass-managed namespace — same rule as the Obsidian import.
    let removed = 0
    for (const entry of readdirSync(importDir)) {
      if (entry.endsWith('.md') && !expected.has(entry)) {
        rmSync(join(importDir, entry), { force: true })
        removed++
      }
    }

    const recordsUpdated = written + removed
    db.insert(integrations)
      .values({
        service: 'notion',
        status: 'connected',
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        errorMessage: null
      })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'notion'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated, errors: null })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'notion',
      status: 'done',
      recordsUpdated
    })
    console.log(`[notion] synced ${written} page(s), skipped ${skipped}, pruned ${removed}`)
    return { service: 'notion', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'notion', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'notion'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'notion',
      status: 'error',
      error: message
    })
    return { service: 'notion', success: false, error: message }
  }
}
