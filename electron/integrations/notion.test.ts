/**
 * Tests for the Notion import (Phase 7 Track B): rich-text + block → markdown
 * rendering (pure), filename/title derivation, and the syncNotion pipeline
 * (mocked Notion API, real temp knowledge dir, real in-memory SQLite for the
 * integration-row bookkeeping).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let knowledge: string
let sqlite: Database.Database
let storedToken: { access_token: string } | null = null

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('../paths', () => ({
  get KNOWLEDGE_DIR() {
    return knowledge
  }
}))

vi.mock('../ipc/auth', () => ({
  loadToken: () => storedToken
}))

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  storedToken = { access_token: 'ntn_test' }
  knowledge = mkdtempSync(join(tmpdir(), 'compass-notion-test-'))
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );
    CREATE TABLE sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER NOT NULL,
      synced_at INTEGER,
      records_updated INTEGER DEFAULT 0,
      errors TEXT
    );
  `)
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
  rmSync(knowledge, { recursive: true, force: true })
})

// ── pure renderers ───────────────────────────────────────────────────────────

const rt = (text: string, extra: Partial<import('./notion').NotionRichText> = {}) => ({
  plain_text: text,
  ...extra
})

describe('richTextToMarkdown', () => {
  it('applies annotations and links', async () => {
    const { richTextToMarkdown } = await import('./notion')
    expect(
      richTextToMarkdown([
        rt('bold', { annotations: { bold: true } }),
        rt(' and '),
        rt('code', { annotations: { code: true } }),
        rt('link', { href: 'https://x.dev' })
      ])
    ).toBe('**bold** and `code`[link](https://x.dev)')
    expect(richTextToMarkdown(undefined)).toBe('')
  })
})

describe('renderBlocks', () => {
  it('renders the common block types', async () => {
    const { renderBlocks } = await import('./notion')
    const lines = renderBlocks([
      { id: '1', type: 'heading_1', heading_1: { rich_text: [rt('Title')] } },
      { id: '2', type: 'paragraph', paragraph: { rich_text: [rt('Body text')] } },
      { id: '3', type: 'to_do', to_do: { rich_text: [rt('done thing')], checked: true } },
      { id: '4', type: 'code', code: { rich_text: [rt('x = 1')], language: 'python' } },
      { id: '5', type: 'divider' },
      { id: '6', type: 'unsupported_fancy_db_view' }
    ])
    const md = lines.join('\n')
    expect(md).toContain('# Title')
    expect(md).toContain('Body text')
    expect(md).toContain('- [x] done thing')
    expect(md).toContain('```python\nx = 1\n```')
    expect(md).toContain('---')
    expect(md).not.toContain('unsupported')
  })

  it('indents children under list items but not under paragraphs', async () => {
    const { renderBlocks } = await import('./notion')
    const lines = renderBlocks([
      {
        id: '1',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [rt('parent')] },
        children: [
          {
            id: '2',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [rt('child')] }
          }
        ]
      },
      {
        id: '3',
        type: 'paragraph',
        paragraph: { rich_text: [rt('para')] },
        children: [{ id: '4', type: 'paragraph', paragraph: { rich_text: [rt('flat child')] } }]
      }
    ])
    expect(lines).toContain('- parent')
    expect(lines).toContain('  - child')
    expect(lines).toContain('flat child')
  })
})

describe('pageTitle / pageFileName', () => {
  const page = (title: string, id = 'abcd1234-5678-90ab-cdef-111122223333') => ({
    id,
    last_edited_time: '2026-06-11T00:00:00.000Z',
    properties: { Name: { type: 'title', title: [rt(title)] } }
  })

  it('derives a slugged, id-suffixed filename', async () => {
    const { pageFileName, pageTitle } = await import('./notion')
    expect(pageTitle(page('My Cool Page!'))).toBe('My Cool Page!')
    expect(pageFileName(page('My Cool Page!'))).toBe('my-cool-page-abcd1234.md')
    expect(pageFileName(page('   '))).toBe('untitled-abcd1234.md')
  })
})

// ── syncNotion ───────────────────────────────────────────────────────────────

const PAGE_A = {
  id: 'aaaa1111-0000-0000-0000-000000000000',
  url: 'https://www.notion.so/a',
  last_edited_time: '2026-06-10T10:00:00.000Z',
  properties: { title: { type: 'title', title: [rt('Project Notes')] } }
}

/** Routes the mocked fetch by URL — search returns `pages`, blocks return `blocks`. */
function mockNotionApi(pages: unknown[], blocks: unknown[] = []): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/search')) {
      return jsonResponse({ results: pages, has_more: false, next_cursor: null })
    }
    if (url.includes('/blocks/')) {
      return jsonResponse({ results: blocks, has_more: false, next_cursor: null })
    }
    return jsonResponse({}, 404)
  })
}

describe('syncNotion', () => {
  it('returns Not connected without touching rows when no token is stored', async () => {
    storedToken = null
    const { syncNotion } = await import('./notion')
    const r = await syncNotion(null)
    expect(r).toEqual({ service: 'notion', success: false, error: 'Not connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM integrations').get()).toMatchObject({ c: 0 })
  })

  it('writes shared pages as frontmattered markdown + logs the sync', async () => {
    mockNotionApi(
      [PAGE_A],
      [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [rt('Hello from Notion')] } }]
    )
    const { syncNotion } = await import('./notion')
    const r = await syncNotion(null)
    expect(r).toMatchObject({ service: 'notion', success: true, recordsUpdated: 1 })

    const file = join(knowledge, 'notion', 'project-notes-aaaa1111.md')
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('source: notion')
    expect(content).toContain('notion-last-edited: 2026-06-10T10:00:00.000Z')
    expect(content).toContain('# Project Notes')
    expect(content).toContain('Hello from Notion')

    const row = sqlite
      .prepare("SELECT status FROM integrations WHERE service = 'notion'")
      .get() as { status: string }
    expect(row.status).toBe('connected')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM sync_events').get()).toMatchObject({ c: 1 })
  })

  it('skips unchanged pages (no block fetch) and prunes unshared ones', async () => {
    mockNotionApi([PAGE_A], [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [rt('v1')] } }])
    const { syncNotion } = await import('./notion')
    await syncNotion(null)
    const blockCallsAfterFirst = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/blocks/')
    ).length
    expect(blockCallsAfterFirst).toBe(1)

    // Second sync: same last_edited_time → no new block fetch, 0 records.
    const r2 = await syncNotion(null)
    expect(r2).toMatchObject({ success: true, recordsUpdated: 0 })
    const blockCallsAfterSecond = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/blocks/')
    ).length
    expect(blockCallsAfterSecond).toBe(1)

    // Third sync: page no longer shared → its file is pruned.
    mockNotionApi([])
    const r3 = await syncNotion(null)
    expect(r3).toMatchObject({ success: true, recordsUpdated: 1 })
    expect(existsSync(join(knowledge, 'notion', 'project-notes-aaaa1111.md'))).toBe(false)
  })

  it('surfaces a first-ever failure via row upsert', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    const { syncNotion } = await import('./notion')
    const r = await syncNotion(null)
    expect(r.success).toBe(false)
    const row = sqlite
      .prepare("SELECT * FROM integrations WHERE service = 'notion'")
      .get() as Record<string, unknown>
    expect(row.status).toBe('error')
    expect(String(row.error_message)).toContain('HTTP 500')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM sync_events').get()).toMatchObject({ c: 1 })
  })

  it('maps a 401 to the reconnect message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401))
    const { syncNotion } = await import('./notion')
    const r = await syncNotion(null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Reconnect')
  })
})
