/**
 * Records / Timeline IPC (Phase 10.1 — "The Acquisition Engine").
 *
 * The Drop Zone: the user hands Compass any data-export file (drag-drop or file
 * picker); a recognizer normalizes it into the append-only `records` timeline.
 * Re-importing the same export is idempotent (UNIQUE `dedup_hash` +
 * `onConflictDoNothing`), exactly like the finance ledger.
 *
 * Local-only: reads files the user explicitly chose, writes a summary to the
 * knowledge base. No network, no vault, no CSP widening. As of Phase 10.7
 * ("Converse") the user opted in to letting the assistant + MCP SEARCH the raw
 * timeline (`records:search` / `search_records` / `compass_search_timeline`),
 * a scoped relaxation that covers `records` ONLY — the vault and raw finance rows
 * stay aggregates-only.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import Database from 'better-sqlite3'
import { type SQL, and, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { appSettings, records, snapshotFacts } from '../db/schema'
import { DEFAULT_EMBED_MODEL } from '../knowledge/embeddings'
import {
  type RecordSemanticHit,
  buildRecordsEmbeddingsIndex,
  loadRecordsIndex,
  saveRecordsIndex,
  searchRecordsSemantic
} from '../knowledge/records-embeddings'
import { updateRecordsKnowledge } from '../knowledge/records-extractor'
import { serializeCsv } from '../lib/csv'
import { extractPdfText } from '../lib/pdf'
import {
  type RecordInput,
  type SnapshotFact,
  hashRecord,
  hashSnapshot,
  recognize,
  recognizePdf,
  recognizeSnapshot,
  recognizeSqlite,
  recognizeStream
} from '../lib/recognizers'
import { type RecordSearchOpts, type TimelineSearchHit, searchRecords } from '../lib/records-search'
import { FIREHOSE_SOURCE_LIST } from '../lib/source-tiers'
import { forEachZipEntry } from '../lib/zip'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024 // 50 MB — matches the contacts/finance guard
const MAX_STREAM_BYTES = 8 * 1024 ** 3 // 8 GB — streaming recognizers read the file incrementally (not as one in-memory string), so multi-GB inputs like a Gmail .mbox / Apple Health export.xml are feasible
const MAX_FILES = 50

/** Read the first `bytes` of a file without loading the whole thing (head-sniff for detection). */
function readHead(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf-8', 0, n)
  } finally {
    closeSync(fd)
  }
}

export interface RecordsImportResult {
  success: boolean
  canceled?: boolean
  error?: string
  imported: number
  duplicates: number
  snapshots: number // non-timeline snapshot facts inserted (ad profile, etc.)
  perFile: Array<{ file: string; recognizer: string | null; imported: number; duplicates: number }>
  unrecognized: string[]
}

type RecordRow = typeof records.$inferSelect

function rowToRecord(row: RecordRow) {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    occurredAt: row.occurredAt ? row.occurredAt.getTime() : null,
    title: row.title,
    body: row.body,
    payload: row.payload,
    provenance: row.provenance,
    ingestedAt: row.ingestedAt ? row.ingestedAt.getTime() : null
  }
}

/** Insert a batch of parsed records, deduping by content hash. Returns counts. */
function insertRecords(inputs: RecordInput[], provenance: string): { imported: number } {
  const db = getDb()
  let imported = 0
  for (const inp of inputs) {
    const res = db
      .insert(records)
      .values({
        source: inp.source,
        type: inp.type,
        occurredAt: inp.occurredAt != null ? new Date(inp.occurredAt) : null,
        title: inp.title.slice(0, 2000),
        body: inp.body ? inp.body.slice(0, 2000) : null,
        payload: inp.payload !== undefined ? JSON.stringify(inp.payload).slice(0, 100_000) : null,
        dedupHash: hashRecord(inp.source, inp.type, inp.occurredAt, inp.naturalKey),
        provenance
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) imported++
  }
  return { imported }
}

/** Insert a batch of snapshot facts, deduping by content hash. Returns counts. */
function insertSnapshotFacts(facts: SnapshotFact[], provenance: string): { imported: number } {
  const db = getDb()
  let imported = 0
  for (const fact of facts) {
    const res = db
      .insert(snapshotFacts)
      .values({
        source: fact.source,
        category: fact.category,
        label: fact.label,
        value: fact.value.slice(0, 2000),
        position: fact.position,
        dedupHash: hashSnapshot(fact.source, fact.category, fact.naturalKey),
        provenance
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) imported++
  }
  return { imported }
}

const MAX_ZIP_DEPTH = 1 // unwrap a Takeout .zip, but not zips-within-zips (bomb guard)

interface IngestCtx {
  perFile: RecordsImportResult['perFile']
  unrecognized: string[]
  imported: number
  duplicates: number
  snapshots: number
}

/** Detect a ZIP archive (Google Takeout etc.) by extension or local-file-header magic. */
function isZip(ext: string, head: string): boolean {
  return ext === 'zip' || head.startsWith('PK\x03\x04')
}

/** Resolve one file: a ZIP unwraps + recurses; anything else routes through the recognizers. */
async function ingestPath(fp: string, name: string, ctx: IngestCtx, depth: number): Promise<void> {
  try {
    const size = statSync(fp).size
    const ext = extname(name).slice(1).toLowerCase()
    // Sniff a head first (cheap) so a ZIP is detected WITHOUT reading the whole
    // archive into a string — it's unwrapped + streamed instead.
    const head = readHead(fp, 65536).replace(/^﻿/, '')

    // ZIP container — unwrap and route each entry through this same dispatch.
    if (isZip(ext, head) && depth < MAX_ZIP_DEPTH) {
      const { skipped } = await forEachZipEntry(fp, (entryName, tmpPath) =>
        ingestPath(tmpPath, entryName, ctx, depth + 1)
      )
      for (const s of skipped) ctx.unrecognized.push(`${name} ▸ ${s}`)
      return
    }

    // SQLite database file (browser history, chat.db, …) — open READ-ONLY + query.
    if (head.startsWith('SQLite format 3')) {
      let db: Database.Database | null = null
      try {
        db = new Database(fp, { readonly: true, fileMustExist: true })
        const rec = recognizeSqlite(db)
        if (rec) {
          const out = rec.parse(db)
          const { imported: imp } = insertRecords(out, name)
          ctx.imported += imp
          ctx.duplicates += out.length - imp
          ctx.perFile.push({
            file: name,
            recognizer: rec.id,
            imported: imp,
            duplicates: out.length - imp
          })
        } else {
          ctx.unrecognized.push(name)
          ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
        }
      } finally {
        db?.close()
      }
      return
    }

    // PDF (credit reports, tax/medical/government letters) — extract text (binary,
    // so handled before the utf-8 read) and route through the PDF recognizers.
    if (head.startsWith('%PDF-')) {
      if (size > MAX_IMPORT_BYTES) {
        ctx.unrecognized.push(`${name} (too large, max 50 MB)`)
        ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
        return
      }
      const { text } = await extractPdfText(fp)
      const rec = recognizePdf(text, name)
      if (rec) {
        const out = rec.parse(text, name)
        const { imported: imp } = insertRecords(out, name)
        ctx.imported += imp
        ctx.duplicates += out.length - imp
        ctx.perFile.push({
          file: name,
          recognizer: rec.id,
          imported: imp,
          duplicates: out.length - imp
        })
      } else {
        ctx.unrecognized.push(name)
        ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
      }
      return
    }

    // Not a zip: small files get a full read so the text recognizers can use it.
    const text = size <= MAX_IMPORT_BYTES ? readFileSync(fp, 'utf-8').replace(/^﻿/, '') : null

    let inputs: RecordInput[] | null = null
    let recognizer: string | null = null
    let snapImported = 0

    const sr = recognizeStream({ name, ext, head })
    if (sr) {
      if (size > MAX_STREAM_BYTES) {
        ctx.unrecognized.push(`${name} (too large, max 8 GB)`)
        ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
        return
      }
      inputs = await sr.parseStream(fp)
      recognizer = sr.id
    } else if (text != null) {
      const rec = recognize({ name, ext, text })
      if (rec) {
        inputs = rec.parse({ name, ext, text })
        recognizer = rec.id
      }
      // Non-timeline snapshot facts — extracted IN ADDITION to any record recognizer
      // (a file can yield both timeline events and static facts).
      const snap = recognizeSnapshot({ name, ext, text })
      if (snap) {
        snapImported = insertSnapshotFacts(snap.parse({ name, ext, text }), name).imported
        if (!recognizer) recognizer = snap.id // so a snapshot-only file isn't "unrecognized"
      }
    } else {
      // Big file no streaming recognizer claimed — we won't read it into memory.
      ctx.unrecognized.push(`${name} (too large, max 50 MB)`)
      ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
      return
    }

    if (inputs == null && recognizer == null) {
      ctx.unrecognized.push(name)
      ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
      return
    }
    const { imported: imp } = inputs ? insertRecords(inputs, name) : { imported: 0 }
    const dup = inputs ? inputs.length - imp : 0
    ctx.imported += imp
    ctx.duplicates += dup
    ctx.snapshots += snapImported
    ctx.perFile.push({ file: name, recognizer, imported: imp + snapImported, duplicates: dup })
  } catch (err) {
    ctx.unrecognized.push(`${name} (${String(err)})`)
    ctx.perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
  }
}

// ── Semantic index (Phase 10.7 "Converse" PR2) ───────────────────────────────
// Records "find by meaning" via the OPT-IN local-Ollama vector index. A module
// lock serializes the (incremental) rebuilds so an import-triggered refresh and a
// manual rebuild can't race on the JSON store.
let semanticBuildInFlight: Promise<unknown> | null = null

/** The embedding model the user configured (shared with the knowledge index). */
function embeddingModel(): string {
  try {
    const row = getDb()
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'embeddingModel'))
      .get()
    return row?.value && row.value.trim().length > 0 ? row.value : DEFAULT_EMBED_MODEL
  } catch {
    return DEFAULT_EMBED_MODEL
  }
}

/** Map a semantic hit into the shared list shape (no term snippets for a meaning match). */
function semanticToHit(h: RecordSemanticHit): TimelineSearchHit {
  return {
    id: h.id,
    source: h.source,
    type: h.type,
    occurredAt: h.occurredAt,
    title: h.title,
    body: h.body,
    titleSnippet: '',
    bodySnippet: '',
    rank: -h.score // -score → lower-is-better, matching the FTS bm25 convention
  }
}

/**
 * Best-effort incremental refresh of the records semantic index after an import.
 * No-op unless the user already built one (semantic is opt-in) — never blocks the
 * import, and a missing/offline Ollama just leaves the index as-is (FTS still works).
 */
async function refreshRecordsSemanticIndex(): Promise<void> {
  if (semanticBuildInFlight) return
  const existing = loadRecordsIndex()
  if (!existing) return
  const run = (async () => {
    const { index } = await buildRecordsEmbeddingsIndex(getRawSqlite(), {
      model: existing.model,
      existing
    })
    // Stop-on-failure preserves the prior vectors, so this only skips a save when the
    // index would be empty — never clobbers a good index because Ollama went offline.
    if (index.embeddings.length > 0) saveRecordsIndex(index)
  })()
  semanticBuildInFlight = run
  try {
    await run
  } catch {
    /* Ollama offline / etc. — leave the prior index in place */
  } finally {
    semanticBuildInFlight = null
  }
}

/**
 * Core ingest shared by the dialog + drag-drop handlers — and by the CRED
 * engine (`electron/ipc/cred.ts`), so a portal-fetched artifact re-enters
 * through the EXACT same validated, content-light pipeline as a manual drop.
 */
export async function ingestFiles(paths: string[]): Promise<RecordsImportResult> {
  const ctx: IngestCtx = {
    perFile: [],
    unrecognized: [],
    imported: 0,
    duplicates: 0,
    snapshots: 0
  }
  for (const fp of paths) await ingestPath(fp, basename(fp), ctx, 0)
  if (ctx.imported > 0) {
    try {
      updateRecordsKnowledge()
    } catch {
      /* knowledge refresh is best-effort */
    }
    // Extend the opt-in semantic index with the new records (fire-and-forget; only
    // does anything if the user has already built one, and never blocks the import).
    void refreshRecordsSemanticIndex()
  }
  return {
    success: true,
    imported: ctx.imported,
    duplicates: ctx.duplicates,
    snapshots: ctx.snapshots,
    perFile: ctx.perFile,
    unrecognized: ctx.unrecognized
  }
}

const CSV_HEADERS = ['occurred_at', 'source', 'type', 'title', 'body']

/** All records as a CSV string, newest first. Shared with the Export Center. */
export function buildRecordsCsv(): string {
  const db = getDb()
  const rows = db.select().from(records).orderBy(desc(records.occurredAt)).all()
  return serializeCsv(
    rows.map((r) => ({
      occurred_at: r.occurredAt ? r.occurredAt.toISOString() : '',
      source: r.source,
      type: r.type,
      title: r.title,
      body: r.body ?? ''
    })),
    CSV_HEADERS
  )
}

const EMPTY: Omit<RecordsImportResult, 'success'> = {
  imported: 0,
  duplicates: 0,
  snapshots: 0,
  perFile: [],
  unrecognized: []
}

export function registerRecordsHandlers(ipcMain: IpcMain): void {
  // Non-timeline snapshot facts for the themed pages (ad profile, etc.), ordered
  // for display. Filterable by source + category; the page groups by `label`.
  ipcMain.handle('snapshot:list', (_event, opts?: { source?: string; category?: string }) => {
    const db = getDb()
    const conds: SQL[] = []
    if (opts?.source) conds.push(eq(snapshotFacts.source, opts.source))
    if (opts?.category) conds.push(eq(snapshotFacts.category, opts.category))
    return db
      .select()
      .from(snapshotFacts)
      .where(and(...conds))
      .orderBy(snapshotFacts.category, snapshotFacts.label, snapshotFacts.position)
      .all()
      .map((r) => ({
        id: r.id,
        source: r.source,
        category: r.category,
        label: r.label,
        value: r.value,
        position: r.position
      }))
  })

  ipcMain.handle(
    'records:list',
    (
      _event,
      opts?: {
        source?: string
        type?: string
        q?: string
        limit?: number
        offset?: number
        includeFirehose?: boolean
      }
    ) => {
      const db = getDb()
      const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 200), 1), 1000)
      const offset = Math.max(Math.trunc(opts?.offset ?? 0), 0)
      const conds: SQL[] = []
      if (opts?.source) {
        conds.push(eq(records.source, opts.source))
      } else if (opts?.includeFirehose === false && FIREHOSE_SOURCE_LIST.length > 0) {
        // Curate (Phase 10.7): collapse firehose sources (browser history, …) from
        // the default browse so they don't bury the signal events. Non-destructive —
        // the rows stay on disk, and selecting the source's chip overrides this.
        conds.push(notInArray(records.source, FIREHOSE_SOURCE_LIST))
      }
      if (opts?.type) conds.push(eq(records.type, opts.type))
      const q = opts?.q?.trim()
      if (q) {
        // Case-insensitive substring search over title + body, server-side so it
        // spans the whole timeline (not just the loaded page). A null body simply
        // doesn't match on body; OR still matches on a hit in the title.
        const term = `%${q}%`
        const m = or(like(records.title, term), like(records.body, term))
        if (m) conds.push(m)
      }
      const rows = db
        .select()
        .from(records)
        .where(and(...conds))
        .orderBy(desc(records.occurredAt), desc(records.id))
        .limit(limit)
        .offset(offset)
        .all()
      return rows.map(rowToRecord)
    }
  )

  // Full-text search across the WHOLE timeline (bm25-ranked), with the same
  // source/type/date filters as the list. The Timeline routes a non-empty query
  // here; an empty query stays on records:list (browse). Raw SQL over records_fts
  // (Drizzle can't model MATCH/bm25), mirroring getFinanceSummary's raw statements.
  ipcMain.handle(
    'records:search',
    async (_event, opts: RecordSearchOpts): Promise<TimelineSearchHit[]> => {
      if (!opts || typeof opts.q !== 'string') return []
      // Sanitize numeric inputs at the boundary — a NaN/Infinity/non-number from the
      // renderer would otherwise bind into the date/limit comparisons and yield
      // surprising empty results. (limit/offset are additionally clamped downstream.)
      const finite = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined
      const base = {
        q: opts.q,
        source: typeof opts.source === 'string' ? opts.source : undefined,
        type: typeof opts.type === 'string' ? opts.type : undefined,
        from: finite(opts.from),
        to: finite(opts.to),
        limit: finite(opts.limit),
        offset: finite(opts.offset)
      }
      // "Find by meaning" — try the opt-in semantic index, transparently falling back
      // to FTS keyword when there's no index (null) or Ollama is offline (throws).
      if (opts.mode === 'semantic') {
        try {
          const hits = await searchRecordsSemantic(getRawSqlite(), opts.q, {
            model: embeddingModel(),
            limit: base.limit ?? 50,
            offset: base.offset, // keep pagination consistent with the FTS path
            source: base.source,
            type: base.type,
            from: base.from ?? null,
            to: base.to ?? null
          })
          if (hits) return hits.map(semanticToHit)
        } catch {
          /* fall through to FTS */
        }
      }
      return searchRecords(getRawSqlite(), base)
    }
  )

  // Build / extend the OPT-IN records semantic index (local Ollama). Serial — the
  // module lock prevents a manual rebuild from racing the import-triggered refresh.
  ipcMain.handle('records:rebuild-semantic', async () => {
    if (semanticBuildInFlight) return { success: false, error: 'A rebuild is already in progress' }
    const run = (async () => {
      const { index, result } = await buildRecordsEmbeddingsIndex(getRawSqlite(), {
        model: embeddingModel()
      })
      // Don't persist a useless index: if nothing got embedded AND there were errors
      // (e.g. Ollama offline), surface the failure instead of saving an empty index
      // that would read as "ready" with zero results.
      if (index.embeddings.length === 0 && result.errors.length > 0) {
        throw new Error(result.errors[0].message || 'Embedding failed')
      }
      saveRecordsIndex(index)
      return result
    })()
    semanticBuildInFlight = run
    try {
      const result = await run
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    } finally {
      semanticBuildInFlight = null
    }
  })

  ipcMain.handle('records:semantic-status', () => {
    const index = loadRecordsIndex()
    return {
      available: Boolean(index && index.embeddings.length > 0),
      builtAt: index?.builtAt ?? null,
      count: index?.embeddings.length ?? 0,
      model: index?.model ?? null,
      building: semanticBuildInFlight !== null
    }
  })

  // "On this day" recap — records sharing today's month + day, from PRIOR years
  // only (so it resurfaces memories rather than echoing today's imports). Matching
  // is done in UTC: some date-only imports (e.g. ISO `YYYY-MM-DD`) are stored at UTC
  // midnight (parseWhen → Date.parse), so UTC matching recovers their source date —
  // local matching can shift them a day in west-of-UTC zones (and disagree with the
  // overview's UTC rendering). Date math runs in SQL on the ms epoch (÷1000 →
  // seconds for strftime, default UTC).
  ipcMain.handle('records:on-this-day', (_event, opts?: { limit?: number }) => {
    const db = getDb()
    const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 50), 1), 200)
    const now = new Date()
    const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
    const year = String(now.getUTCFullYear())
    const monthDay = sql`strftime('%m-%d', ${records.occurredAt} / 1000, 'unixepoch')`
    const yr = sql`strftime('%Y', ${records.occurredAt} / 1000, 'unixepoch')`
    const rows = db
      .select()
      .from(records)
      .where(sql`${monthDay} = ${mmdd} AND ${yr} <> ${year}`)
      .orderBy(desc(records.occurredAt), desc(records.id))
      .limit(limit)
      .all()
    return rows.map(rowToRecord)
  })

  // At-a-glance totals for the Timeline header — the TRUE total (the Timeline UI
  // only loads a 500-row page via records:list), distinct source count, and the
  // dated span. One aggregate query.
  ipcMain.handle('records:stats', () => {
    const db = getDb()
    const row = db
      .select({
        total: sql<number>`count(*)`,
        sources: sql<number>`count(distinct ${records.source})`,
        earliest: sql<number | null>`min(${records.occurredAt})`,
        latest: sql<number | null>`max(${records.occurredAt})`
      })
      .from(records)
      .get()
    // Count of collapsed firehose records (browser history, …) so the Timeline can
    // label its "Show browsing (N)" toggle. 0 when nothing firehose is imported.
    const firehose =
      FIREHOSE_SOURCE_LIST.length > 0
        ? (db
            .select({ n: sql<number>`count(*)` })
            .from(records)
            .where(inArray(records.source, FIREHOSE_SOURCE_LIST))
            .get()?.n ?? 0)
        : 0
    return {
      total: row?.total ?? 0,
      sources: row?.sources ?? 0,
      earliest: row?.earliest ?? null,
      latest: row?.latest ?? null,
      firehose
    }
  })

  // Distinct sources + kinds across the WHOLE timeline, for the filter chips. The
  // list (records:list) is capped at a 500-row page, so deriving chips from it
  // would hide sources/kinds that only appear deeper in the history — and a chip
  // built that way would also filter only the loaded page. Facets come from the
  // full table so a chip selection (pushed back through records:list's server-side
  // source/type filter) spans everything, consistent with full-timeline search.
  ipcMain.handle('records:facets', () => {
    const db = getDb()
    const rows = db
      .select({ source: records.source, type: records.type })
      .from(records)
      .groupBy(records.source, records.type)
      .all()
    const sources = [...new Set(rows.map((r) => r.source))].sort()
    const types = [...new Set(rows.map((r) => r.type))].sort()
    return { sources, types }
  })

  ipcMain.handle('records:import', async (): Promise<RecordsImportResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import a data export (CSV / JSON / XML / mbox / zip / sqlite / pdf)',
      filters: [
        {
          name: 'Data exports',
          extensions: ['csv', 'json', 'xml', 'mbox', 'zip', 'sqlite', 'db', 'pdf']
        },
        // Chrome's history DB is the extensionless file `History`, so allow any file.
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true, ...EMPTY }
    return ingestFiles(filePaths.slice(0, MAX_FILES))
  })

  ipcMain.handle(
    'records:import-paths',
    async (_event, paths: string[]): Promise<RecordsImportResult> => {
      const files = Array.isArray(paths)
        ? paths.filter((p) => typeof p === 'string').slice(0, MAX_FILES)
        : []
      if (files.length === 0) {
        return { success: false, error: 'No files provided', ...EMPTY }
      }
      return ingestFiles(files)
    }
  )
}
