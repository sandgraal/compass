/**
 * Global search across the four content domains that the May 2026
 * strategic review flagged as table stakes: knowledge bodies, vault
 * titles (never bodies — secrets stay encrypted), checklist titles,
 * and transaction descriptions.
 *
 * Returns a single ranked list the renderer can fan out into typed
 * sections without doing the cross-domain JOIN itself. Capped at 40
 * results overall so the ⌘K palette stays scrollable.
 *
 * Why title-only for vault: even surfacing the field VALUES through the
 * search index would defeat the whole "renderer never sees secrets"
 * boundary. The title is the user-supplied label for the entry; if they
 * named the entry "Chase Sapphire", searching "chase" should find it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import {
  checklistItems,
  financeTransactions as financeTxns,
  knowledgeFiles as knowledgeFilesTable
} from '../db/schema'
import { decryptBlob, getOrCreateKey } from '../lib/crypto-vault'
import { KNOWLEDGE_DIR, VAULT_DIR } from '../paths'

export type GlobalSearchHit =
  | {
      kind: 'knowledge'
      path: string
      title: string
      snippet: string
      score: number
    }
  | {
      kind: 'vault'
      category: string
      id: string
      title: string
      score: number
    }
  | {
      kind: 'task'
      id: number
      title: string
      listType: string
      listDate: string
      done: boolean
      score: number
    }
  | {
      kind: 'transaction'
      id: number
      date: string
      amount: number
      description: string
      score: number
    }

const MAX_RESULTS = 40
const MAX_PER_KIND = 12

// Same five categories the vault knows about; mirrored here so we don't
// have to take a dependency on `electron/ipc/vault.ts` (which would
// pull in its own dialog-using imports).
const VAULT_CATEGORIES = ['financial', 'identity', 'credentials', 'medical', 'legal']

// Per-category preferred title field. Falls back to the next available
// human-readable label so we always emit *something* searchable.
const TITLE_FIELDS_BY_CATEGORY: Record<string, string[]> = {
  financial: ['institution', 'accountType', 'name', 'title'],
  identity: ['name', 'documentType', 'title'],
  credentials: ['service', 'name', 'username', 'title'],
  medical: ['provider', 'condition', 'name', 'title'],
  legal: ['title', 'name', 'documentType']
}

function pickTitle(category: string, entry: Record<string, unknown>): string {
  for (const field of TITLE_FIELDS_BY_CATEGORY[category] ?? []) {
    const v = entry[field]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
  }
  for (const v of Object.values(entry)) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
  }
  return '(untitled)'
}

function walkKnowledge(dir: string, base: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkKnowledge(full, base))
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      out.push(relative(base, full))
    }
  }
  return out
}

function scoreMatch(haystack: string, needle: string): number {
  const lc = haystack.toLowerCase()
  const idx = lc.indexOf(needle)
  if (idx === -1) return 0
  // Earlier matches rank higher; whole-word > substring; shorter haystacks
  // beat long ones when the position tie-breaks.
  const positional = Math.max(0, 100 - idx)
  const wholeWord = new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(haystack) ? 50 : 0
  const lengthPenalty = Math.min(40, Math.floor(haystack.length / 50))
  return positional + wholeWord - lengthPenalty
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTitle(content: string, fileName: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : basename(fileName, '.md')
}

function searchKnowledge(query: string): GlobalSearchHit[] {
  const lq = query.toLowerCase()
  const hits: GlobalSearchHit[] = []
  for (const rel of walkKnowledge(KNOWLEDGE_DIR, KNOWLEDGE_DIR)) {
    const full = join(KNOWLEDGE_DIR, rel)
    try {
      const content = readFileSync(full, 'utf8')
      const titleHit = scoreMatch(extractTitle(content, rel), lq)
      const bodyIdx = content.toLowerCase().indexOf(lq)
      if (titleHit === 0 && bodyIdx === -1) continue
      const score = titleHit > 0 ? titleHit + 80 : scoreMatch(content, lq)
      const idx = bodyIdx >= 0 ? bodyIdx : 0
      const snippet = content
        .slice(Math.max(0, idx - 40), idx + 100)
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      hits.push({
        kind: 'knowledge',
        path: rel,
        title: extractTitle(content, rel),
        snippet,
        score
      })
    } catch {
      /* ignore unreadable file */
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, MAX_PER_KIND)
}

function searchVault(query: string): GlobalSearchHit[] {
  // Vault search must NEVER decrypt + return secret fields. We decrypt in
  // the main process, extract only the title field, and discard the rest
  // before returning to the renderer.
  const lq = query.toLowerCase()
  const hits: GlobalSearchHit[] = []
  let key: Buffer
  try {
    key = getOrCreateKey()
  } catch {
    return []
  }
  for (const category of VAULT_CATEGORIES) {
    const path = join(VAULT_DIR, `${category}.enc`)
    if (!existsSync(path)) continue
    try {
      const blob = readFileSync(path)
      if (!statSync(path).isFile()) continue
      const json = decryptBlob(blob, key)
      const entries = JSON.parse(json) as Array<Record<string, unknown>>
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const id = entry.id
        if (typeof id !== 'string') continue
        const title = pickTitle(category, entry)
        const score = scoreMatch(title, lq)
        if (score === 0) continue
        hits.push({ kind: 'vault', category, id, title, score })
      }
    } catch {
      /* category file may be corrupted or wrong key; skip */
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, MAX_PER_KIND)
}

function searchTasks(query: string): GlobalSearchHit[] {
  const lq = query.toLowerCase()
  const db = getDb()
  const rows = db
    .select({
      id: checklistItems.id,
      title: checklistItems.title,
      listType: checklistItems.listType,
      listDate: checklistItems.listDate,
      checked: checklistItems.checked
    })
    .from(checklistItems)
    .all()
  const hits: GlobalSearchHit[] = []
  for (const r of rows) {
    const score = scoreMatch(r.title ?? '', lq)
    if (score === 0) continue
    hits.push({
      kind: 'task',
      id: r.id,
      title: r.title,
      listType: r.listType,
      listDate: r.listDate,
      done: Boolean(r.checked),
      score
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, MAX_PER_KIND)
}

function searchTransactions(query: string): GlobalSearchHit[] {
  const lq = query.toLowerCase()
  const db = getDb()
  // Pull only the columns we need — the table can grow large.
  const rows = db
    .select({
      id: financeTxns.id,
      date: financeTxns.date,
      amount: financeTxns.amount,
      description: financeTxns.description
    })
    .from(financeTxns)
    .all()
  const hits: GlobalSearchHit[] = []
  for (const r of rows) {
    const score = scoreMatch(r.description ?? '', lq)
    if (score === 0) continue
    hits.push({
      kind: 'transaction',
      id: r.id,
      date: r.date,
      amount: r.amount,
      description: r.description,
      score
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, MAX_PER_KIND)
}

export function registerSearchHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('search:global', (_event, query: unknown) => {
    if (typeof query !== 'string') return { hits: [] as GlobalSearchHit[] }
    const trimmed = query.trim().toLowerCase()
    if (trimmed.length < 2) return { hits: [] as GlobalSearchHit[] }

    const knowledge = searchKnowledge(trimmed)
    const vault = searchVault(trimmed)
    const tasks = searchTasks(trimmed)
    const transactions = searchTransactions(trimmed)

    const all = [...knowledge, ...vault, ...tasks, ...transactions]
    all.sort((a, b) => b.score - a.score)
    return {
      hits: all.slice(0, MAX_RESULTS),
      counts: {
        knowledge: knowledge.length,
        vault: vault.length,
        tasks: tasks.length,
        transactions: transactions.length
      }
    }
  })

  // Lightweight call sites used elsewhere — the renderer can also pull
  // each domain on its own, but the unified handler above is the primary
  // entry point.
  ipcMain.handle('knowledge:list-file-index', () => {
    // Used by backlinks code paths that want the (path, title) tuple
    // without re-reading file contents. Mirrors the DB-cached index.
    const db = getDb()
    return db.select().from(knowledgeFilesTable).all()
  })
}

export const _internal = {
  searchKnowledge,
  searchVault,
  searchTasks,
  searchTransactions,
  scoreMatch
}
