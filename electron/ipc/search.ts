/**
 * Global search — the ⌘K surface over EVERYTHING, per the data-access
 * policy (docs/data-access-policy.md): knowledge bodies, the records
 * spine (FTS — timeline, finance, medical, habits, tasks-as-records,
 * trips, paystubs, facts…), checklist titles, contacts, and vault
 * BODIES for the document categories.
 *
 * Returns a single ranked list the renderer can fan out into typed
 * sections without doing the cross-domain JOIN itself.
 *
 * The two walls that remain:
 *  - vault `credentials` stays title-only (the `service` label). Passwords,
 *    API keys, and usernames are access keys, not life data — indexing
 *    them is leak risk with zero search value.
 *  - vault bodies are decrypted PER QUERY in the main process and never
 *    written to any on-disk index; only the matched snippet crosses the
 *    IPC boundary.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { like } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { checklistItems, contacts, knowledgeFiles as knowledgeFilesTable } from '../db/schema'
import { decryptBlob, getOrCreateKey } from '../lib/crypto-vault'
import { searchRecords } from '../lib/records-search'
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
      /** ±40-char window around a body match (open categories only). */
      snippet?: string
      /** Which entry field matched, e.g. 'notes' / 'policyNumber'. */
      matchedField?: string
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
      kind: 'record'
      id: number
      source: string
      type: string
      occurredAt: number | null
      title: string
      snippet: string
      score: number
    }
  | {
      kind: 'contact'
      id: number
      displayName: string
      org: string | null
      relationship: string | null
      score: number
    }

const MAX_RESULTS = 60
const MAX_PER_KIND = 12
const MAX_QUERY_LENGTH = 200

// Same six categories the vault knows about; mirrored here so we don't
// have to take a dependency on `electron/ipc/vault.ts` (which would
// pull in its own dialog-using imports).
const VAULT_CATEGORIES = [
  'financial',
  'identity',
  'credentials',
  'medical',
  'legal',
  'foreign-accounts'
]

// Document categories whose FULL bodies are searchable (decrypt-per-query,
// nothing persisted). `credentials` is deliberately absent — it stays
// title-only below.
const OPEN_VAULT_CATEGORIES = new Set([
  'financial',
  'identity',
  'medical',
  'legal',
  'foreign-accounts'
])

// Per-category label fields used as the hit TITLE. For the open categories
// these are just the preferred display labels (body fields are searchable
// too); for `credentials` this allowlist is the ENTIRE searchable surface.
//
// `username` is excluded from `credentials` even though it's the most
// natural alternate label, because usernames are sensitive in their own
// right (think: linked email addresses, identifiers used elsewhere).
const TITLE_FIELDS_BY_CATEGORY: Record<string, string[]> = {
  financial: ['institution', 'accountType'],
  identity: ['documentType', 'name'],
  credentials: ['service'],
  medical: ['provider', 'condition'],
  legal: ['title', 'documentType'],
  'foreign-accounts': ['institution', 'country']
}

function pickTitle(category: string, entry: Record<string, unknown>): string | null {
  for (const field of TITLE_FIELDS_BY_CATEGORY[category] ?? []) {
    const v = entry[field]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
  }
  return null
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

/** ±40-char window around the first match of `lq` in `value` (for vault snippets). */
function matchWindow(value: string, lq: string): string {
  const idx = value.toLowerCase().indexOf(lq)
  const at = idx >= 0 ? idx : 0
  return value
    .slice(Math.max(0, at - 40), at + lq.length + 40)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function searchVault(query: string): GlobalSearchHit[] {
  // Decrypt-per-query in the main process; nothing is ever written to an
  // on-disk index. Open (document) categories are body-searchable per the
  // data-access policy; `credentials` remains title-only — passwords and
  // API keys never cross the IPC boundary, not even as snippets.
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

        // Title (label) match — works for every category, credentials included.
        const titleScore = title === null ? 0 : scoreMatch(title, lq)
        if (titleScore > 0 && title !== null) {
          hits.push({ kind: 'vault', category, id, title, score: titleScore })
          continue
        }

        // Body match — open categories only. Scan every string field of the
        // entry and return the matched field + a snippet window.
        if (!OPEN_VAULT_CATEGORIES.has(category)) continue
        for (const [field, value] of Object.entries(entry)) {
          if (field === 'id' || typeof value !== 'string' || !value.trim()) continue
          const score = scoreMatch(value, lq)
          if (score === 0) continue
          hits.push({
            kind: 'vault',
            category,
            id,
            title: title ?? `${category} entry`,
            snippet: matchWindow(value, lq),
            matchedField: field,
            score
          })
          break // one hit per entry — the first matching field wins
        }
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

/**
 * The records spine via FTS — one query covers finance txns, medical,
 * habits, trips, paystubs, bills, goals, facts, and every import source.
 * (This replaced the old LIKE-scan transaction domain: finance rows live
 * on the spine now, so they arrive here with everything else.)
 */
function searchRecordsSpine(query: string): GlobalSearchHit[] {
  const lq = query.toLowerCase()
  let rows: ReturnType<typeof searchRecords>
  try {
    rows = searchRecords(getRawSqlite(), { q: query, limit: MAX_PER_KIND })
  } catch {
    return [] // records_fts absent on an odd/old DB
  }
  return rows.map((r, i) => {
    const titleScore = scoreMatch(r.title, lq)
    return {
      kind: 'record' as const,
      id: r.id,
      source: r.source,
      type: r.type,
      occurredAt: r.occurredAt,
      title: r.title,
      snippet: (r.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      // Title matches rank like the other domains; body/payload-only FTS
      // matches get a floor that decays with bm25 order (rows arrive best-first).
      score: titleScore > 0 ? titleScore + 10 : Math.max(10, 40 - i * 3)
    }
  })
}

function searchContacts(query: string): GlobalSearchHit[] {
  const lq = query.toLowerCase()
  const db = getDb()
  // Same searchBlob LIKE idiom as `contacts:list` — never selects
  // photo/enrichment, so the palette payload stays light.
  const rows = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      org: contacts.org,
      relationship: contacts.relationship
    })
    .from(contacts)
    .where(like(contacts.searchBlob, `%${lq}%`))
    .all()
  const hits: GlobalSearchHit[] = []
  for (const r of rows) {
    const nameScore = scoreMatch(r.displayName ?? '', lq)
    hits.push({
      kind: 'contact',
      id: r.id,
      displayName: r.displayName,
      org: r.org,
      relationship: r.relationship,
      // Blob-only matches (email/phone/nickname) still surface, below name matches.
      score: nameScore > 0 ? nameScore + 20 : 30
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, MAX_PER_KIND)
}

export function registerSearchHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('search:global', (_event, query: unknown) => {
    if (typeof query !== 'string') return { hits: [] as GlobalSearchHit[] }
    // IPC boundary cap. Unbounded queries would let a buggy or hostile
    // renderer cause the search helpers to scan every file/row with a
    // pathological needle.
    if (query.length > MAX_QUERY_LENGTH) return { hits: [] as GlobalSearchHit[] }
    const trimmed = query.trim().toLowerCase()
    if (trimmed.length < 2) return { hits: [] as GlobalSearchHit[] }

    const knowledge = searchKnowledge(trimmed)
    const vault = searchVault(trimmed)
    const tasks = searchTasks(trimmed)
    const records = searchRecordsSpine(trimmed)
    const contactHits = searchContacts(trimmed)

    const all = [...knowledge, ...vault, ...tasks, ...records, ...contactHits]
    all.sort((a, b) => b.score - a.score)
    return {
      hits: all.slice(0, MAX_RESULTS),
      counts: {
        knowledge: knowledge.length,
        vault: vault.length,
        tasks: tasks.length,
        records: records.length,
        contacts: contactHits.length
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
  searchRecordsSpine,
  searchContacts,
  scoreMatch
}
