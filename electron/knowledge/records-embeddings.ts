/**
 * Semantic ("find by meaning") search over the unified `records` Timeline —
 * Phase 10.7 "Converse" PR2.
 *
 * Reuses the local-Ollama embedding primitives from `embeddings.ts`
 * (`embedText`, `cosineSimilarity`, `DEFAULT_EMBED_MODEL`) but keeps a SEPARATE,
 * compact index — one vector per record, keyed by `records.id` — instead of the
 * markdown chunk index. That avoids destabilizing the (shipped, tested) knowledge
 * path and matches the data: a record is one short line, not a chunked document.
 *
 * Same trust posture as the knowledge index: everything runs on-machine against a
 * local Ollama, nothing leaves the disk, and it is strictly OPT-IN — the index
 * only exists once the user builds it. Search degrades to FTS keyword (the always-
 * available default) when there's no index or Ollama is offline.
 *
 * Incremental: `records` is append-only, so a rebuild only embeds ids greater than
 * the highest already embedded (`maxId`). A capped index bounds both the JSON store
 * and the in-JS cosine scan (tens of thousands of vectors stay sub-second).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { DATA_DIR } from '../paths'
import { DEFAULT_EMBED_MODEL, type EmbedOptions, cosineSimilarity, embedText } from './embeddings'

const INDEX_PATH = join(DATA_DIR, 'records-embeddings.json')

/** Bounds the on-disk store + the in-JS cosine scan. Tunable later via settings. */
export const DEFAULT_RECORD_EMBED_CAP = 20_000

export interface RecordEmbedding {
  id: number
  vector: number[]
}

export interface RecordsEmbeddingIndex {
  /** Embedding model that produced these vectors; a model change invalidates them. */
  model: string
  builtAt: number
  /** Highest `records.id` embedded — append-only ⇒ only newer ids need work. */
  maxId: number
  embeddings: RecordEmbedding[]
}

export interface RecordSemanticHit {
  id: number
  source: string
  type: string
  occurredAt: number | null
  title: string
  body: string | null
  score: number
}

interface RecordRow {
  id: number
  source: string
  type: string
  occurredAt: number | null
  title: string
  body: string | null
}

/** One short embedding text per record — title carries the signal, body/source/date add context. */
export function recordEmbedText(r: {
  title: string
  body: string | null
  source: string
  occurredAt: number | null
}): string {
  const day = r.occurredAt != null ? new Date(r.occurredAt).toISOString().slice(0, 10) : ''
  const head = r.body ? `${r.title} — ${r.body}` : r.title
  const tail = [r.source, day].filter(Boolean).join(', ')
  return tail ? `${head} (${tail})` : head
}

export function loadRecordsIndex(indexPath = INDEX_PATH): RecordsEmbeddingIndex | null {
  if (!existsSync(indexPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as RecordsEmbeddingIndex
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.maxId !== 'number' ||
      !Array.isArray(parsed.embeddings)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveRecordsIndex(index: RecordsEmbeddingIndex, indexPath = INDEX_PATH): void {
  const dir = dirname(indexPath)
  if (!existsSync(dir)) return // DATA_DIR is created at app start; skip in bare unit tests
  const tmp = `${indexPath}.tmp`
  writeFileSync(tmp, JSON.stringify(index), 'utf8')
  try {
    renameSync(tmp, indexPath)
  } catch {
    writeFileSync(indexPath, JSON.stringify(index), 'utf8')
  }
}

export interface BuildRecordsIndexOptions {
  model?: string
  /** Inject the embed function — used by tests (no network). */
  embed?: (text: string, options: EmbedOptions) => Promise<number[]>
  /** Provide an existing index for an incremental build (else loaded from disk). */
  existing?: RecordsEmbeddingIndex | null
  /** Override the index path — used by tests. */
  indexPath?: string
  /** Max total records embedded. */
  cap?: number
  signal?: AbortSignal
}

export interface BuildRecordsIndexResult {
  embedded: number // newly embedded this run
  total: number // total vectors in the index
  durationMs: number
  errors: Array<{ id: number; message: string }>
}

/**
 * Build (or incrementally extend) the records embedding index. Reuses the prior
 * index when the model matches and only embeds records with `id > maxId`, up to
 * `cap` total. A model change discards the prior vectors (mixing models makes
 * cosine meaningless). Returns the new index; the caller persists via `saveRecordsIndex`.
 */
export async function buildRecordsEmbeddingsIndex(
  sqlite: Database.Database,
  options: BuildRecordsIndexOptions = {}
): Promise<{ index: RecordsEmbeddingIndex; result: BuildRecordsIndexResult }> {
  const startedAt = Date.now()
  const model = options.model ?? DEFAULT_EMBED_MODEL
  const embed = options.embed ?? embedText
  const cap = options.cap ?? DEFAULT_RECORD_EMBED_CAP
  const existing = options.existing ?? loadRecordsIndex(options.indexPath)
  const reuse = existing && existing.model === model

  const kept: RecordEmbedding[] = reuse ? existing.embeddings.slice(0, cap) : []
  let maxId = reuse ? existing.maxId : 0
  const errors: Array<{ id: number; message: string }> = []

  const remaining = cap - kept.length
  let embedded = 0
  if (remaining > 0) {
    const rows = sqlite
      .prepare(
        'SELECT id, source, type, occurred_at AS occurredAt, title, body FROM records WHERE id > ? ORDER BY id LIMIT ?'
      )
      .all(maxId, remaining) as RecordRow[]
    for (const r of rows) {
      if (options.signal?.aborted) throw new Error('Build aborted')
      try {
        const vector = await embed(recordEmbedText(r), { model, signal: options.signal })
        kept.push({ id: r.id, vector })
        embedded++
      } catch (err) {
        errors.push({ id: r.id, message: (err as Error).message })
        // One bad row shouldn't abort the whole build; record it and move on.
      }
      if (r.id > maxId) maxId = r.id
    }
  }

  const index: RecordsEmbeddingIndex = { model, builtAt: startedAt, maxId, embeddings: kept }
  return {
    index,
    result: { embedded, total: kept.length, durationMs: Date.now() - startedAt, errors }
  }
}

export interface SearchRecordsSemanticOptions {
  model?: string
  embed?: (text: string, options: EmbedOptions) => Promise<number[]>
  index?: RecordsEmbeddingIndex | null
  indexPath?: string
  minScore?: number
  limit?: number
  source?: string
  type?: string
  from?: number | null
  to?: number | null
  signal?: AbortSignal
}

/**
 * Semantic search over the records index. Returns `null` when there's no index
 * (caller should fall back to FTS); throws when the query embedding fails (Ollama
 * offline) — also a fall-back signal. Scores every vector, hydrates the top
 * candidates from `records`, applies the same source/type/date filters as the FTS
 * path, and returns the best `limit` hits.
 */
export async function searchRecordsSemantic(
  sqlite: Database.Database,
  query: string,
  options: SearchRecordsSemanticOptions = {}
): Promise<RecordSemanticHit[] | null> {
  const q = query.trim()
  if (q.length < 2) return []
  const index = options.index ?? loadRecordsIndex(options.indexPath)
  if (!index || index.embeddings.length === 0) return null

  const model = options.model ?? index.model
  if (model !== index.model) return null // incompatible vectors — let the caller use FTS

  const embed = options.embed ?? embedText
  const queryVector = await embed(q, { model, signal: options.signal })

  const minScore = options.minScore ?? 0.25
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 25), 200))

  // Score every vector, keep those above the floor, best-first.
  const scored: Array<{ id: number; score: number }> = []
  for (const e of index.embeddings) {
    const score = cosineSimilarity(queryVector, e.vector)
    if (score >= minScore) scored.push({ id: e.id, score })
  }
  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []

  // Hydrate a bounded candidate set, then apply filters + the limit. (The vector
  // index isn't filtered, so source/type/date are post-filters on the rows.)
  const candidates = scored.slice(0, Math.max(limit * 4, 100))
  const byId = new Map(candidates.map((c) => [c.id, c.score]))
  const placeholders = candidates.map(() => '?').join(',')
  const rows = sqlite
    .prepare(
      `SELECT id, source, type, occurred_at AS occurredAt, title, body FROM records WHERE id IN (${placeholders})`
    )
    .all(...candidates.map((c) => c.id)) as RecordRow[]

  const hits: RecordSemanticHit[] = []
  for (const r of rows) {
    if (options.source && r.source !== options.source) continue
    if (options.type && r.type !== options.type) continue
    if (options.from != null && (r.occurredAt == null || r.occurredAt < options.from)) continue
    if (options.to != null && (r.occurredAt == null || r.occurredAt > options.to)) continue
    hits.push({ ...r, score: byId.get(r.id) ?? 0 })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

export const _internal = { INDEX_PATH }
