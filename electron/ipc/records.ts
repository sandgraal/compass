/**
 * Records / Timeline IPC (Phase 10.1 — "The Acquisition Engine").
 *
 * The Drop Zone: the user hands Compass any data-export file (drag-drop or file
 * picker); a recognizer normalizes it into the append-only `records` timeline.
 * Re-importing the same export is idempotent (UNIQUE `dedup_hash` +
 * `onConflictDoNothing`), exactly like the finance ledger.
 *
 * Local-only: reads files the user explicitly chose, writes a summary to the
 * knowledge base. No network, no vault, no CSP widening. The assistant + MCP
 * SEARCH the timeline in full detail (`records:search` / `search_records` /
 * `compass_search_timeline`) — per the data-access policy every domain projects
 * onto `records`; the one exclusion is raw GPS coordinates, which stay in
 * `location_points` off the spine. See docs/data-access-policy.md.
 */

import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import Database from 'better-sqlite3'
import { type SQL, and, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { appSettings, locationPoints, records, snapshotFacts, timelineMutes } from '../db/schema'
import { readActiveKeyInternal } from '../integrations/assistant-vault'
import { LlmAbortError, callLlm } from '../integrations/llm-client'
import { afterLocationImport } from '../integrations/location-residency'
import { DEFAULT_EMBED_MODEL } from '../knowledge/embeddings'
import {
  type RecordSemanticHit,
  buildRecordsEmbeddingsIndex,
  loadRecordsIndex,
  saveRecordsIndex,
  searchRecordsSemantic
} from '../knowledge/records-embeddings'
import { updateRecordsKnowledge } from '../knowledge/records-extractor'
import { isAmazonTelemetryProvenance } from '../lib/amazon-export'
import { serializeCsv } from '../lib/csv'
import { isPlausibleEpochMs } from '../lib/dates'
import { refreshDerivedEntities } from '../lib/entities-projection'
import { LOCATION_RECOGNIZER_IDS, type LocationPayload } from '../lib/location'
import { planNetflixRefile } from '../lib/netflix-refile'
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
import {
  daySummary,
  onThisDayAllYears,
  recordsForDay,
  recordsHistogram
} from '../lib/records-aggregates'
import { planReclassify } from '../lib/records-reclassify'
import { type RecordSearchOpts, type TimelineSearchHit, searchRecords } from '../lib/records-search'
import {
  buildYearReview,
  yearReviewMarkdown,
  yearReviewNarrationPrompt,
  yearReviewNarrative
} from '../lib/records-year-review'
import { FIREHOSE_SOURCE_LIST, isFirehose } from '../lib/source-tiers'
import { type MuteSet, rankMemories } from '../lib/timeline-memories'
import { momentsForDay } from '../lib/timeline-moments'
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

/** The user's "never resurface" vetoes, shaped for rankMemories. */
function loadMuteSet(): MuteSet {
  const recordIds = new Set<number>()
  const sourceTypes = new Set<string>()
  try {
    for (const m of getDb().select().from(timelineMutes).all()) {
      if (m.kind === 'record') {
        const id = Number(m.target)
        if (Number.isFinite(id)) recordIds.add(id)
      } else if (m.kind === 'source-type') {
        sourceTypes.add(m.target)
      }
    }
  } catch {
    /* table absent on an odd/old DB — no mutes */
  }
  return { recordIds, sourceTypes }
}

/**
 * Last line of defense for `occurred_at`: recognizers already route ambiguous
 * cells through `parseWhen` (which range-checks), but live projectors and
 * future writers hand epoch ms straight in — clamp implausible values (before
 * 1970 / more than 5 years out) to UNDATED here so no writer can reintroduce
 * absurd-year rows.
 */
function plausibleOccurredAt(ms: number | null | undefined): Date | null {
  if (ms == null || !isPlausibleEpochMs(ms)) return null
  return new Date(ms)
}

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

/**
 * Insert a batch of parsed records, deduping by content hash. Returns counts.
 *
 * Exported so the live-integration projectors (`electron/ipc/storehouse-sync.ts`)
 * reuse the exact same dedup + FTS-trigger + truncation path as file imports.
 */
export function insertRecords(inputs: RecordInput[], provenance: string): { imported: number } {
  const db = getDb()
  let imported = 0
  for (const inp of inputs) {
    // Hash the CLAMPED timestamp so a row's identity always matches what's
    // stored: if a writer hands in an implausible occurredAt (stored UNDATED),
    // hashing the raw value would let the same event re-arrive later with a
    // corrected-to-null date and duplicate instead of deduping. Identical for
    // every plausible timestamp (clamp is a no-op there).
    const occurredAt = plausibleOccurredAt(inp.occurredAt)
    const occurredAtMs = occurredAt ? occurredAt.getTime() : null
    const res = db
      .insert(records)
      .values({
        source: inp.source,
        type: inp.type,
        occurredAt,
        title: inp.title.slice(0, 2000),
        body: inp.body ? inp.body.slice(0, 2000) : null,
        payload: inp.payload !== undefined ? JSON.stringify(inp.payload).slice(0, 100_000) : null,
        dedupHash: hashRecord(inp.source, inp.type, occurredAtMs, inp.naturalKey),
        provenance
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) imported++
  }
  return { imported }
}

/**
 * Insert a batch of location points into the DEDICATED `location_points` table —
 * deliberately NOT the `records` spine. This is the ONE exclusion in the data-access
 * policy (docs/data-access-policy.md): every other domain projects onto the spine in
 * full detail, but raw GPS coordinates never enter `records` — the assistant/MCP
 * timeline search has no per-source denylist, so keeping coordinates out of the table
 * is the wall. Only the derived, coarse `travel_segments` (country + date window)
 * surface, and those DO project. Dedup + the content-addressed hash mirror
 * `insertRecords`. Points without a timestamp or valid coordinates are skipped
 * (useless for residency).
 */
export function insertLocationPoints(
  inputs: RecordInput[],
  _provenance: string
): { imported: number } {
  const db = getDb()
  let imported = 0
  for (const inp of inputs) {
    if (inp.occurredAt == null) continue
    const p = inp.payload as LocationPayload | undefined
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue
    const res = db
      .insert(locationPoints)
      .values({
        occurredAt: new Date(inp.occurredAt),
        lat: p.lat,
        lng: p.lng,
        accuracy: typeof p.acc === 'number' ? p.acc : null,
        src: p.src ?? inp.source,
        dedupHash: hashRecord(inp.source, inp.type, inp.occurredAt, inp.naturalKey)
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) imported++
  }
  return { imported }
}

/**
 * Upsert a batch of LIVE-projected records (`electron/ipc/storehouse-sync.ts`).
 *
 * Unlike file imports — where `occurredAt` is part of an event's identity (the same
 * title on two dates is two events) — a live-projected record represents ONE mutable
 * domain row (a GitHub issue, a Linear task, an email thread) whose `occurredAt`
 * (updated_at / received_at / start) CHANGES over time. So the dedup key EXCLUDES
 * `occurredAt` (stable per `source|type|naturalKey`) and a re-projection UPDATES the
 * existing row in place — refreshing occurred_at/title/body/payload — instead of
 * spamming the timeline with a new row on every sync. The `records_au` FTS trigger
 * keeps search in sync on update. Returns new-insert + update counts.
 */
export function upsertLiveRecords(
  inputs: RecordInput[],
  provenance: string
): { imported: number; updated: number } {
  const db = getDb()
  if (inputs.length === 0) return { imported: 0, updated: 0 }
  // Stable per-domain-row hash (occurredAt excluded via `null`).
  const withHash = inputs.map((inp) => ({
    inp,
    dedupHash: hashRecord(inp.source, inp.type, null, inp.naturalKey)
  }))
  const existing = new Set(
    db
      .select({ h: records.dedupHash })
      .from(records)
      .where(
        inArray(
          records.dedupHash,
          withHash.map((w) => w.dedupHash)
        )
      )
      .all()
      .map((r) => r.h)
  )
  let imported = 0
  let updated = 0
  for (const { inp, dedupHash } of withHash) {
    const values = {
      occurredAt: plausibleOccurredAt(inp.occurredAt),
      title: inp.title.slice(0, 2000),
      body: inp.body ? inp.body.slice(0, 2000) : null,
      payload: inp.payload !== undefined ? JSON.stringify(inp.payload).slice(0, 100_000) : null
    }
    db.insert(records)
      .values({ source: inp.source, type: inp.type, dedupHash, provenance, ...values })
      .onConflictDoUpdate({
        target: records.dedupHash,
        set: { ...values, provenance, ingestedAt: new Date() }
      })
      .run()
    if (existing.has(dedupHash)) updated++
    else imported++
  }
  return { imported, updated }
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
  locationImported: number // points routed to `location_points` (off the `records` spine)
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
    // Location recognizers divert to the dedicated `location_points` table (raw
    // coordinates stay OFF the `records` spine / FTS / MCP); everything else lands
    // in `records`.
    const isLocation = recognizer != null && LOCATION_RECOGNIZER_IDS.has(recognizer)
    const { imported: imp } = inputs
      ? isLocation
        ? insertLocationPoints(inputs, name)
        : insertRecords(inputs, name)
      : { imported: 0 }
    const dup = inputs ? inputs.length - imp : 0
    if (isLocation) ctx.locationImported += imp
    else ctx.imported += imp
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

/** app_settings gate for the opt-in Year-in-Review LLM narration (Timeline 2.1). */
export const YEAR_REVIEW_NARRATION_KEY = 'yearReviewNarrationEnabled'
/** Separate from assistant:ask's controller so narration never cancels a live Ask. */
let yearReviewNarrateController: AbortController | null = null

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
    snapshots: 0,
    locationImported: 0
  }
  for (const fp of paths) await ingestPath(fp, basename(fp), ctx, 0)
  if (ctx.imported > 0) {
    try {
      updateRecordsKnowledge()
    } catch {
      /* knowledge refresh is best-effort */
    }
    // Cross-reference the new records into the derived-entity cache (People /
    // Merchants / Places / subscription candidates). Synchronous but scoped to the
    // sources with extractors; best-effort so a failure never fails the import.
    try {
      refreshDerivedEntities(getDb())
    } catch {
      /* derived-entity projection is best-effort */
    }
    // Extend the opt-in semantic index with the new records (fire-and-forget; only
    // does anything if the user has already built one, and never blocks the import).
    void refreshRecordsSemanticIndex()
  }
  // New location points → re-derive travel segments so the residency engine updates
  // automatically. Guarded to fire only when a location export actually landed
  // (keeps it off the hot path for every other import) and best-effort (never fails
  // the import).
  if (ctx.locationImported > 0) {
    try {
      afterLocationImport()
    } catch {
      /* location derivation is best-effort */
    }
  }
  return {
    success: true,
    imported: ctx.imported + ctx.locationImported,
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

export const RECORDS_RECLASSIFY_KEY = 'recordsReclassifyV1'
/**
 * V2 re-runs the (idempotent, dedupe-safe) reclassification for the families
 * added after V1 shipped: rider-app GPS fixes → location_points, Digital
 * Items, gift-card transactions. Installs that already consumed V1 pick the
 * new families up here; fresh installs only ever run V2 (a superset).
 */
export const RECORDS_RECLASSIFY_V2_KEY = 'recordsReclassifyV2'

export type ReclassifyResult = {
  moved: number // generic rows re-inserted as properly-sourced records
  located: number // generic rows moved to location_points
  deleted: number // generic rows removed (= moved + located)
}

/**
 * Re-derive already-imported 'generic' rows whose export family now has a real
 * recognizer (`amazon-export.ts`). Lossless: each row's original CSV row lives
 * in `payload`, so the mapper re-reads it, the row is re-inserted through the
 * production `insertRecords` / `insertLocationPoints` paths (hashing,
 * truncation, FTS triggers, date guardrail), and only then is the generic row
 * deleted — all in one transaction. A future re-import of the same file
 * dedupes against the reclassified rows instead of duplicating them. Rows no
 * family claims are left untouched (source-tiers collapses them as firehose).
 */
export function reclassifyGenericRecords(): ReclassifyResult {
  const sqlite = getRawSqlite()
  const result: ReclassifyResult = { moved: 0, located: 0, deleted: 0 }
  const selectChunk = sqlite.prepare(
    "SELECT id, provenance, payload FROM records WHERE source = 'generic' AND id > ? ORDER BY id LIMIT 5000"
  )
  const deleteById = sqlite.prepare('DELETE FROM records WHERE id = ?')

  const processChunk = sqlite.transaction(
    (
      chunk: Array<{
        id: number
        provenance: string | null
        payload: string | null
      }>
    ) => {
      const plan = planReclassify(chunk)
      // Preserve each row's original import filename on the re-inserted record.
      const byProvenance = new Map<string, RecordInput[]>()
      for (const move of plan.records) {
        const list = byProvenance.get(move.provenance)
        if (list) list.push(move.input)
        else byProvenance.set(move.provenance, [move.input])
      }
      for (const [provenance, inputs] of byProvenance) insertRecords(inputs, provenance)
      if (plan.locations.length > 0) {
        insertLocationPoints(
          plan.locations.map((m) => m.input),
          'reclassify'
        )
      }
      for (const move of plan.records) deleteById.run(move.deleteId)
      for (const move of plan.locations) deleteById.run(move.deleteId)
      return plan
    }
  )

  let lastId = 0
  for (;;) {
    const chunk = selectChunk.all(lastId) as Array<{
      id: number
      provenance: string | null
      payload: string | null
    }>
    if (chunk.length === 0) break
    lastId = chunk[chunk.length - 1].id
    const plan = processChunk(chunk)
    result.moved += plan.records.length
    result.located += plan.locations.length
    result.deleted += plan.records.length + plan.locations.length
  }

  if (result.deleted > 0) {
    try {
      refreshDerivedEntities(getDb())
    } catch {
      /* derived-entity projection is best-effort */
    }
    void refreshRecordsSemanticIndex()
    if (result.located > 0) {
      try {
        afterLocationImport()
      } catch {
        /* location derivation is best-effort */
      }
    }
  }
  return result
}

/**
 * App-launch wrapper: run the reclassification exactly once per install, gated
 * on an app_settings key written only AFTER success (crash → retried next
 * launch; the reclassify is dedup-safe so retries are safe). Same pattern as
 * `recordsDateRepairV1` / `financeSnapshotRepairV1`. The gate key is a
 * parameter so each expansion of `AMAZON_REFILE_FAMILIES` ships as a new key
 * (V2, …) that re-runs over installs whose earlier key is already consumed.
 */
export function runRecordsReclassifyIfNeeded(
  gateKey: string = RECORDS_RECLASSIFY_V2_KEY
): { ran: boolean } & Partial<ReclassifyResult> {
  const db = getDb()
  const existing = db.select().from(appSettings).where(eq(appSettings.key, gateKey)).get()
  if (existing) return { ran: false }
  const res = reclassifyGenericRecords()
  db.insert(appSettings).values({ key: gateKey, value: new Date().toISOString() }).run()
  return { ran: true, ...res }
}

export const NETFLIX_REFILE_KEY = 'netflixRefileV1'

export type NetflixRefileResult = {
  moved: number // rows re-inserted as properly-sourced records (prime-video, notes)
  facts: number // rows converted to snapshot facts (bookmarks, saved places)
  // Netflix rows removed — always moved + facts: the misfiled row is deleted
  // even when its re-insert dedupes against an already-existing record/fact.
  deleted: number
}

/**
 * Re-file rows the over-greedy Netflix recognizer misclaimed (see
 * `netflix-refile.ts`): Prime Video playback sessions, Google Maps saved
 * lists, bookmark CSVs, note exports. Same lossless executor shape as
 * `reclassifyGenericRecords` — re-derive from the stored payload, insert
 * through the production paths, delete the old row in the same transaction.
 * Real Netflix rows are untouched (no mapper claims their {Title, Date} shape).
 */
export function refileNetflixRecords(): NetflixRefileResult {
  const sqlite = getRawSqlite()
  const result: NetflixRefileResult = { moved: 0, facts: 0, deleted: 0 }
  const selectChunk = sqlite.prepare(
    "SELECT id, provenance, payload FROM records WHERE source = 'netflix' AND id > ? ORDER BY id LIMIT 5000"
  )
  const deleteById = sqlite.prepare('DELETE FROM records WHERE id = ?')

  const processChunk = sqlite.transaction(
    (chunk: Array<{ id: number; provenance: string | null; payload: string | null }>) => {
      const plan = planNetflixRefile(chunk)
      const byProvenance = new Map<string, RecordInput[]>()
      for (const move of plan.records) {
        const list = byProvenance.get(move.provenance)
        if (list) list.push(move.input)
        else byProvenance.set(move.provenance, [move.input])
      }
      for (const [provenance, inputs] of byProvenance) insertRecords(inputs, provenance)
      for (const move of plan.facts) insertSnapshotFacts([move.fact], move.provenance)
      for (const move of plan.records) deleteById.run(move.deleteId)
      for (const move of plan.facts) deleteById.run(move.deleteId)
      return plan
    }
  )

  let lastId = 0
  for (;;) {
    const chunk = selectChunk.all(lastId) as Array<{
      id: number
      provenance: string | null
      payload: string | null
    }>
    if (chunk.length === 0) break
    lastId = chunk[chunk.length - 1].id
    const plan = processChunk(chunk)
    result.moved += plan.records.length
    result.facts += plan.facts.length
    result.deleted += plan.records.length + plan.facts.length
  }

  if (result.deleted > 0) {
    try {
      refreshDerivedEntities(getDb())
    } catch {
      /* derived-entity projection is best-effort */
    }
    void refreshRecordsSemanticIndex()
  }
  return result
}

/** One-shot launch wrapper for the netflix refile, same gate pattern as reclassify. */
export function runNetflixRefileIfNeeded(): { ran: boolean } & Partial<NetflixRefileResult> {
  const db = getDb()
  const existing = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, NETFLIX_REFILE_KEY))
    .get()
  if (existing) return { ran: false }
  const res = refileNetflixRecords()
  db.insert(appSettings).values({ key: NETFLIX_REFILE_KEY, value: new Date().toISOString() }).run()
  return { ran: true, ...res }
}

export const GENERIC_TELEMETRY_PURGE_KEY = 'genericTelemetryPurgeV1'

/**
 * One-shot purge of the Amazon-export telemetry rows (user-approved,
 * 2026-07-11). After the V2 reclassify promotes every claimed family, what
 * that archive left under 'generic' is device telemetry (DeviceState pings,
 * impression / notification metadata — ~150k rows) that the user chose to
 * delete rather than keep firehose-hidden. Scoped by provenance fingerprint
 * (`isAmazonTelemetryProvenance`) so generic rows from any OTHER unrecognized
 * import are never touched — 'generic' is the catch-all for every dated CSV
 * without a recognizer, not just this archive. Chunked so each DELETE (and
 * its FTS trigger fan-out) commits in a bounded transaction. Re-importing the
 * export restores the rows; the consumed gate means later imports are never
 * purged.
 *
 * Refuses to run until the V2 reclassify gate is written — purging first would
 * destroy the GPS/order/gift-card rows V2 exists to promote.
 */
export function runGenericTelemetryPurgeIfNeeded(): { ran: boolean; deleted?: number } {
  const db = getDb()
  const reclassified = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, RECORDS_RECLASSIFY_V2_KEY))
    .get()
  if (!reclassified) return { ran: false }
  const existing = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, GENERIC_TELEMETRY_PURGE_KEY))
    .get()
  if (existing) return { ran: false }

  const sqlite = getRawSqlite()
  const selectChunk = sqlite.prepare(
    "SELECT id, provenance FROM records WHERE source = 'generic' AND id > ? ORDER BY id LIMIT 5000"
  )
  const deleteById = sqlite.prepare('DELETE FROM records WHERE id = ?')
  const deleteChunk = sqlite.transaction((ids: number[]) => {
    for (const id of ids) deleteById.run(id)
  })
  let deleted = 0
  let lastId = 0
  for (;;) {
    const chunk = selectChunk.all(lastId) as Array<{ id: number; provenance: string | null }>
    if (chunk.length === 0) break
    lastId = chunk[chunk.length - 1].id
    const ids = chunk.filter((r) => isAmazonTelemetryProvenance(r.provenance)).map((r) => r.id)
    if (ids.length > 0) {
      deleteChunk(ids)
      deleted += ids.length
    }
  }
  if (deleted > 0) void refreshRecordsSemanticIndex()
  db.insert(appSettings)
    .values({ key: GENERIC_TELEMETRY_PURGE_KEY, value: new Date().toISOString() })
    .run()
  return { ran: true, deleted }
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
        sources?: string[] // multi-select chips (Timeline 2.0); wins over `source`
        type?: string
        types?: string[]
        q?: string
        from?: number // epoch ms, inclusive
        to?: number // epoch ms, inclusive
        limit?: number
        offset?: number
        includeFirehose?: boolean
      }
    ) => {
      const db = getDb()
      const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 200), 1), 1000)
      const offset = Math.max(Math.trunc(opts?.offset ?? 0), 0)
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : []
      const sources = strings(opts?.sources)
      const types = strings(opts?.types)
      const conds: SQL[] = []
      if (sources.length > 0) {
        conds.push(inArray(records.source, sources))
      } else if (opts?.source) {
        conds.push(eq(records.source, opts.source))
      } else if (opts?.includeFirehose === false && FIREHOSE_SOURCE_LIST.length > 0) {
        // Curate (Phase 10.7): collapse firehose sources (browser history, …) from
        // the default browse so they don't bury the signal events. Non-destructive —
        // the rows stay on disk, and selecting the source's chip overrides this.
        conds.push(notInArray(records.source, FIREHOSE_SOURCE_LIST))
      }
      if (types.length > 0) conds.push(inArray(records.type, types))
      else if (opts?.type) conds.push(eq(records.type, opts.type))
      const finiteMs = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined
      const from = finiteMs(opts?.from)
      const to = finiteMs(opts?.to)
      if (from != null) conds.push(sql`${records.occurredAt} >= ${from}`)
      if (to != null) conds.push(sql`${records.occurredAt} <= ${to}`)
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
        offset: finite(opts.offset),
        includeFirehose: opts.includeFirehose === true
      }
      // Mirrors searchRecords: firehose hits are dropped unless asked for, or
      // unless the search is explicitly scoped to a firehose source.
      const keepHit = (source: string): boolean =>
        base.includeFirehose ||
        (base.source != null && isFirehose(base.source)) ||
        !isFirehose(source)
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
          if (hits) return hits.filter((h) => keepHit(h.source)).map(semanticToHit)
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
    const conds: SQL[] = [sql`${monthDay} = ${mmdd} AND ${yr} <> ${year}`]
    // Telemetry is not a memory: keep firehose sources out of the recap (they'd
    // otherwise dominate it now that 'generic' is tiered as firehose).
    if (FIREHOSE_SOURCE_LIST.length > 0) {
      conds.push(notInArray(records.source, FIREHOSE_SOURCE_LIST))
    }
    const rows = db
      .select()
      .from(records)
      .where(and(...conds))
      .orderBy(desc(records.occurredAt), desc(records.id))
      .limit(200) // fetch wide, then rank down to the requested limit
      .all()
    // Memory ranking (PR 6): mutes + sensitivity + score-ordering, so the
    // Dashboard card and the Timeline hero agree on what a memory is.
    return rankMemories(rows.map(rowToRecord), { mutes: loadMuteSet(), cap: limit })
  })

  // ── Timeline 2.0 aggregates (PR 3) — the year scrubber / heatmap / day
  // drill-down / all-years hero backend. Pure query logic lives in
  // electron/lib/records-aggregates.ts (raw SQL whose strftime expressions
  // match the 0033 expression indexes); these handlers just validate inputs.

  ipcMain.handle(
    'records:histogram',
    (
      _event,
      opts?: {
        bucket?: 'year' | 'month'
        source?: string
        type?: string
        from?: number
        to?: number
        includeFirehose?: boolean
      }
    ) => {
      const finite = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined
      return recordsHistogram(getRawSqlite(), {
        bucket: opts?.bucket === 'month' ? 'month' : 'year',
        source: typeof opts?.source === 'string' ? opts.source : undefined,
        type: typeof opts?.type === 'string' ? opts.type : undefined,
        from: finite(opts?.from),
        to: finite(opts?.to),
        includeFirehose: opts?.includeFirehose === true
      })
    }
  )

  ipcMain.handle(
    'records:day',
    (
      _event,
      opts?: {
        day?: string
        source?: string
        type?: string
        limit?: number
        offset?: number
        includeFirehose?: boolean
      }
    ) => {
      if (typeof opts?.day !== 'string') return []
      return recordsForDay(getRawSqlite(), {
        day: opts.day,
        source: typeof opts.source === 'string' ? opts.source : undefined,
        type: typeof opts.type === 'string' ? opts.type : undefined,
        limit: typeof opts.limit === 'number' ? opts.limit : undefined,
        offset: typeof opts.offset === 'number' ? opts.offset : undefined,
        includeFirehose: opts.includeFirehose === true
      })
    }
  )

  ipcMain.handle('records:day-summary', (_event, opts?: { day?: string }) => {
    if (typeof opts?.day !== 'string') return []
    return daySummary(getRawSqlite(), { day: opts.day })
  })

  ipcMain.handle(
    'records:on-this-day-v2',
    (_event, opts?: { month?: number; day?: number; perYearCap?: number }) => {
      // Default to TODAY (UTC — matches v1's date-only-import rationale) and
      // exclude the current year only when showing today: any other requested
      // month-day is deliberate browsing, where every year is fair game.
      const now = new Date()
      const month = typeof opts?.month === 'number' ? opts.month : now.getUTCMonth() + 1
      const day = typeof opts?.day === 'number' ? opts.day : now.getUTCDate()
      const isToday = month === now.getUTCMonth() + 1 && day === now.getUTCDate()
      const cap = Math.min(Math.max(Math.trunc(opts?.perYearCap ?? 6), 1), 50)
      // Fetch each year WIDE (lib max), then memory-rank down to the cap —
      // mutes + sensitivity out, distinctive records above burst noise.
      const years = onThisDayAllYears(getRawSqlite(), {
        month,
        day,
        perYearCap: 50,
        excludeYear: isToday ? now.getUTCFullYear() : undefined
      })
      const mutes = loadMuteSet()
      return years
        .map((y) => ({ ...y, records: rankMemories(y.records, { mutes, cap }) }))
        .filter((y) => y.records.length > 0)
    }
  )

  // Anniversary "moments" for a month-day: birthdays, entity firsts,
  // big-purchase anniversaries, today's renewals (timeline-moments.ts).
  ipcMain.handle('records:moments', (_event, opts?: { month?: number; day?: number }) => {
    const now = new Date()
    const month = typeof opts?.month === 'number' ? opts.month : now.getUTCMonth() + 1
    const day = typeof opts?.day === 'number' ? opts.day : now.getUTCDate()
    if (!Number.isInteger(month) || month < 1 || month > 12) return []
    if (!Number.isInteger(day) || day < 1 || day > 31) return []
    return momentsForDay(getRawSqlite(), {
      month,
      day,
      currentYear: now.getUTCFullYear(),
      isToday: month === now.getUTCMonth() + 1 && day === now.getUTCDate()
    })
  })

  // Year in Review (PR 7): one year distilled — pure records-year-review.ts.
  ipcMain.handle('records:year-review', (_event, opts?: { year?: number }) => {
    const year = Math.trunc(opts?.year ?? new Date().getUTCFullYear())
    if (!Number.isInteger(year) || year < 1970 || year > 2100) return null
    const review = buildYearReview(getRawSqlite(), year)
    return { ...review, narrative: yearReviewNarrative(review) }
  })

  ipcMain.handle(
    'records:year-review-markdown',
    (_event, opts?: { year?: number; narrative?: string }) => {
      const year = Math.trunc(opts?.year ?? new Date().getUTCFullYear())
      if (!Number.isInteger(year) || year < 1970 || year > 2100) return null
      // The renderer passes the DISPLAYED narrative (LLM prose when present) so
      // the export matches what the user is looking at; else the template.
      const override = typeof opts?.narrative === 'string' ? opts.narrative.trim() : ''
      return yearReviewMarkdown(buildYearReview(getRawSqlite(), year), override || undefined)
    }
  )

  // Save a shareable Year-in-Review PNG (Timeline 2.1). The renderer rasterizes
  // the SVG card to a base64 PNG (local, no network) and hands the bytes here;
  // this shows a save dialog and writes them. Purely local file I/O.
  ipcMain.handle(
    'records:export-year-review-image',
    async (_event, opts?: { year?: number; pngBase64?: string }) => {
      const year = Math.trunc(opts?.year ?? new Date().getUTCFullYear())
      // Validate the year window like the other Year Review handlers.
      if (!Number.isInteger(year) || year < 1970 || year > 2100) {
        return { saved: false, error: 'bad-year' }
      }
      const b64 = typeof opts?.pngBase64 === 'string' ? opts.pngBase64 : ''
      // Reject anything that isn't a base64 string up front (cheap, bounds the
      // decode). The ~11 MB encoded ceiling ≈ 8 MB decoded — a coarse first cut.
      if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length > 11_000_000) {
        return { saved: false, error: 'bad-image' }
      }
      // Decode once, then enforce the real (decoded-byte) cap and confirm the
      // payload is actually a PNG — the renderer only ever produces PNGs, so a
      // mismatch means a malformed/hostile payload we should not write.
      const buf = Buffer.from(b64, 'base64')
      const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      if (buf.length === 0 || buf.length > 8_000_000 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return { saved: false, error: 'bad-image' }
      }
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: `Save ${year} in Review`,
        defaultPath: `year-review-${year}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      })
      if (canceled || !filePath) return { saved: false, canceled: true }
      try {
        writeFileSync(filePath, buf)
        return { saved: true, path: filePath }
      } catch (err) {
        return { saved: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Optional LLM narration for Year in Review (Timeline 2.1). Separate async
  // handler so records:year-review stays instant with the template; this only
  // runs when the user has opted into cloud narration AND a BYO key is set.
  // Uses its OWN AbortController so it never cancels an in-flight assistant:ask.
  ipcMain.handle('records:year-review-narrate', async (_event, opts?: { year?: number }) => {
    const year = Math.trunc(opts?.year ?? new Date().getUTCFullYear())
    if (!Number.isInteger(year) || year < 1970 || year > 2100)
      return { ok: false, reason: 'bad-year' }
    // Opt-in gate — narration egress is off unless the user turned it on.
    let enabled = false
    try {
      const row = getDb()
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, YEAR_REVIEW_NARRATION_KEY))
        .get()
      enabled = row?.value === 'true'
    } catch {
      /* setting absent → disabled */
    }
    if (!enabled) return { ok: false, reason: 'off' }
    const auth = readActiveKeyInternal()
    if (!auth) return { ok: false, reason: 'no-key' }
    const prompt = yearReviewNarrationPrompt(buildYearReview(getRawSqlite(), year))
    if (!prompt) return { ok: false, reason: 'empty' }
    yearReviewNarrateController?.abort()
    const controller = new AbortController()
    yearReviewNarrateController = controller
    try {
      const res = await callLlm({
        provider: auth.provider,
        apiKey: auth.key,
        model: auth.model,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        maxTokens: 300,
        signal: controller.signal
      })
      const narrative = res.text.trim().slice(0, 1200)
      if (!narrative) return { ok: false, reason: 'empty' }
      return { ok: true, narrative, provider: auth.provider }
    } catch (err) {
      if (err instanceof LlmAbortError) return { ok: false, reason: 'cancelled' }
      return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (yearReviewNarrateController === controller) yearReviewNarrateController = null
    }
  })

  // ── Memory mutes (PR 6): "never resurface this" — reversible, never deletion.
  ipcMain.handle('records:mute', (_event, opts?: { kind?: string; target?: string | number }) => {
    const kind = opts?.kind
    if (kind !== 'record' && kind !== 'source-type') {
      return { success: false, error: 'Unknown mute kind' }
    }

    const target = String(opts?.target ?? '').slice(0, 500)
    if (!target) return { success: false, error: 'Missing mute target' }

    if (kind === 'record') {
      const id = Number(target)
      if (!Number.isInteger(id) || id <= 0) {
        return { success: false, error: 'Invalid record id' }
      }
    }

    getDb().insert(timelineMutes).values({ kind, target }).onConflictDoNothing().run()
    return { success: true }
  })

  ipcMain.handle('records:mutes', () => {
    return getDb()
      .select()
      .from(timelineMutes)
      .all()
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        target: m.target
      }))
  })

  ipcMain.handle('records:clear-mutes', () => {
    getDb().delete(timelineMutes).run()
    return { success: true }
  })

  // At-a-glance totals for the Timeline header — the TRUE total (the Timeline UI
  // only loads a 500-row page via records:list), distinct source count, and the
  // dated span (one aggregate), plus a second small aggregate for the collapsed
  // firehose count (the "Show browsing (N hidden)" toggle).
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

  // Re-derive already-imported 'generic' rows through the real recognizers
  // (amazon-export families). Idempotent + dedup-safe, so a manual re-run after
  // a future family is added just converts the newly-covered rows.
  ipcMain.handle('records:reclassify-generic', () => {
    try {
      return { success: true, ...reclassifyGenericRecords() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('records:import', async (): Promise<RecordsImportResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import a data export (CSV / JSON / XML / mbox / zip / sqlite / pdf)',
      filters: [
        {
          name: 'Data exports',
          extensions: ['csv', 'json', 'xml', 'mbox', 'zip', 'sqlite', 'db', 'pdf', 'gpx', 'rec']
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
