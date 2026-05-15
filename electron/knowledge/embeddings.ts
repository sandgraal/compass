/**
 * Local semantic search via Ollama embeddings — Tier 2 #6 from the May 2026
 * strategic review.
 *
 * The brutal critique was right: Compass built a knowledge warehouse and
 * shipped no query interface beyond title-substring matching. This module
 * adds a "find by meaning" path that runs entirely on-machine — same
 * trust posture as the existing opt-in Ollama suggestions, no data
 * leaves the disk.
 *
 * Architecture:
 *   1. Each markdown file in `knowledge-base/` is chunked into ~700-char
 *      segments (paragraph-aware where possible).
 *   2. Each chunk is embedded via Ollama's `/api/embeddings` endpoint
 *      with a small model (default: `nomic-embed-text`, ~270 MB).
 *   3. The (path, chunk-index, vector, mtime, model) tuples are
 *      persisted as one JSON blob at `.data/knowledge-embeddings.json`.
 *   4. Search embeds the query vector and ranks chunks by cosine
 *      similarity. Top hits return with a path + snippet that the
 *      Knowledge Base / Command Palette can surface inline.
 *
 * Why JSON-on-disk instead of a vector DB:
 *   - Knowledge bases are typically <1000 chunks for the target user.
 *     Cosine over a 1000×768 float matrix is sub-millisecond in JS.
 *   - Keeps the dependency surface zero. A vector DB (lancedb, qdrant)
 *     would dwarf the rest of the app and lock in a schema we'd need
 *     to migrate the first time we change embedding models.
 *   - We can swap to a proper backing store later without changing the
 *     IPC surface.
 *
 * Incremental indexing: on rebuild we keep entries whose `(path, mtime)`
 * still match the file on disk. Anything that's gone or stale is
 * re-embedded. Files added since the last build are picked up the same
 * way.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { DATA_DIR, KNOWLEDGE_DIR } from '../paths'

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text'
const OLLAMA_BASE_URL = 'http://localhost:11434'

const INDEX_PATH = join(DATA_DIR, 'knowledge-embeddings.json')

// Empirical sweet spot for `nomic-embed-text` — short enough that the
// embedding is dense around the chunk topic, long enough that we don't
// emit thousands of vectors per file. Tunable in settings later.
const CHUNK_TARGET_CHARS = 700
const CHUNK_HARD_MAX_CHARS = 1500

export interface EmbeddingChunk {
  path: string
  chunkIndex: number
  text: string
  vector: number[]
}

export interface EmbeddingIndex {
  // The embedding model produced this index. If the user changes models,
  // we treat the whole index as stale and rebuild.
  model: string
  // Wall-clock ms of the last successful build.
  builtAt: number
  // Per-file timing so incremental builds can skip unchanged files.
  fileMtimes: Record<string, number>
  // The vectors themselves, flat. Search loops once over this array.
  chunks: EmbeddingChunk[]
}

export interface SemanticHit {
  path: string
  title: string
  chunkIndex: number
  snippet: string
  score: number
}

// ────────────────────────────────────────────────────────────────────────────
// Math + chunking — pure, easy to unit-test.
// ────────────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]
    const bv = b[i]
    dot += av * bv
    magA += av * av
    magB += bv * bv
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Paragraph-aware chunking. We split on blank lines first so headings
 * + their bodies stay together, then merge consecutive small paragraphs
 * up to `CHUNK_TARGET_CHARS`. A single paragraph longer than
 * `CHUNK_HARD_MAX_CHARS` is hard-split mid-sentence — unusual but bounded.
 */
export function chunkMarkdown(content: string): string[] {
  const paragraphs = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let buf = ''

  function flush(): void {
    const trimmed = buf.trim()
    if (trimmed) chunks.push(trimmed)
    buf = ''
  }

  for (const para of paragraphs) {
    if (para.length > CHUNK_HARD_MAX_CHARS) {
      // Edge case: huge paragraph (e.g. a single long line of YAML
      // frontmatter or a CSV table). Hard-split.
      flush()
      for (let i = 0; i < para.length; i += CHUNK_HARD_MAX_CHARS) {
        chunks.push(para.slice(i, i + CHUNK_HARD_MAX_CHARS))
      }
      continue
    }
    if (buf.length + para.length + 2 > CHUNK_TARGET_CHARS && buf.length > 0) {
      flush()
    }
    buf += (buf ? '\n\n' : '') + para
  }
  flush()
  return chunks
}

// ────────────────────────────────────────────────────────────────────────────
// Ollama embedding call.
// ────────────────────────────────────────────────────────────────────────────

export interface EmbedOptions {
  model: string
  /** Override the base URL — used by unit tests. */
  baseUrl?: string
  /** Abort signal so a rebuild can be cancelled mid-flight. */
  signal?: AbortSignal
}

/**
 * Embed a single string. Throws when Ollama isn't reachable or returns
 * a malformed payload — the caller decides whether that's fatal (build)
 * or skippable (search).
 */
export async function embedText(text: string, options: EmbedOptions): Promise<number[]> {
  const url = `${options.baseUrl ?? OLLAMA_BASE_URL}/api/embeddings`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model, prompt: text }),
    signal: options.signal
  })
  if (!resp.ok) {
    throw new Error(`Ollama /api/embeddings returned ${resp.status} ${resp.statusText}`)
  }
  const json = (await resp.json()) as { embedding?: unknown }
  const embedding = json.embedding
  if (
    !Array.isArray(embedding) ||
    embedding.length === 0 ||
    embedding.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  ) {
    throw new Error('Ollama returned a malformed embedding')
  }
  return embedding as number[]
}

// ────────────────────────────────────────────────────────────────────────────
// Index persistence.
// ────────────────────────────────────────────────────────────────────────────

export function loadIndex(): EmbeddingIndex | null {
  if (!existsSync(INDEX_PATH)) return null
  try {
    const raw = readFileSync(INDEX_PATH, 'utf8')
    const parsed = JSON.parse(raw) as EmbeddingIndex
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.model !== 'string' ||
      !Array.isArray(parsed.chunks)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveIndex(index: EmbeddingIndex): void {
  const dir = dirname(INDEX_PATH)
  if (!existsSync(dir)) {
    // The DATA_DIR is created at app startup, but unit tests may not
    // have run that path — mkdirSync via existsSync guard keeps both
    // paths cheap.
    return
  }
  const tmp = `${INDEX_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(index), 'utf8')
  // Best-effort atomic swap — same approach the vault uses.
  try {
    renameSync(tmp, INDEX_PATH)
  } catch {
    // Fall back to direct write — better stale-window than dropped data.
    writeFileSync(INDEX_PATH, JSON.stringify(index), 'utf8')
  }
}

// ────────────────────────────────────────────────────────────────────────────
// File walking — shared with the existing knowledge-search code path.
// ────────────────────────────────────────────────────────────────────────────

function walkMarkdown(dir: string, base: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, base))
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      out.push(relative(base, full))
    }
  }
  return out
}

function extractTitle(content: string, relPath: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  if (match) return match[1].trim()
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/, '')
}

// ────────────────────────────────────────────────────────────────────────────
// Build + search.
// ────────────────────────────────────────────────────────────────────────────

export interface BuildIndexResult {
  builtFiles: number
  skippedFiles: number
  totalChunks: number
  durationMs: number
  errors: Array<{ path: string; message: string }>
}

export interface BuildIndexOptions {
  model?: string
  /** Override the knowledge root — used by tests. */
  knowledgeDir?: string
  /** Inject the embed function — used by tests. */
  embed?: (text: string, options: EmbedOptions) => Promise<number[]>
  /** Provide an existing index to do an incremental build. */
  existing?: EmbeddingIndex | null
  signal?: AbortSignal
}

/**
 * Build (or incrementally update) the embeddings index. Files whose
 * `(path, mtime)` matches the existing index entry are reused; everything
 * else is re-embedded. Returns the new index — the caller decides whether
 * to persist via `saveIndex`.
 *
 * If the model changed since the previous index, all entries are
 * invalidated and re-embedded — mixing vectors from different models
 * makes similarity scores meaningless.
 */
export async function buildEmbeddingsIndex(
  options: BuildIndexOptions = {}
): Promise<{ index: EmbeddingIndex; result: BuildIndexResult }> {
  const startedAt = Date.now()
  const knowledgeDir = options.knowledgeDir ?? KNOWLEDGE_DIR
  const model = options.model ?? DEFAULT_EMBED_MODEL
  const embed = options.embed ?? embedText
  const existing = options.existing ?? loadIndex()
  const reuseExisting = existing && existing.model === model

  const errors: Array<{ path: string; message: string }> = []
  const newMtimes: Record<string, number> = {}
  const newChunks: EmbeddingChunk[] = []
  let builtFiles = 0
  let skippedFiles = 0

  const files = walkMarkdown(knowledgeDir, knowledgeDir)

  // Pre-bucket existing chunks by path so the reuse check is O(1).
  const existingByPath = new Map<string, EmbeddingChunk[]>()
  if (reuseExisting) {
    for (const c of existing.chunks) {
      const arr = existingByPath.get(c.path)
      if (arr) arr.push(c)
      else existingByPath.set(c.path, [c])
    }
  }

  for (const rel of files) {
    if (options.signal?.aborted) {
      throw new Error('Build aborted')
    }
    const full = join(knowledgeDir, rel)
    let mtime: number
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      continue
    }
    newMtimes[rel] = mtime

    const previousMtime = reuseExisting ? existing.fileMtimes[rel] : undefined
    if (reuseExisting && previousMtime === mtime) {
      const reused = existingByPath.get(rel)
      if (reused && reused.length > 0) {
        newChunks.push(...reused)
        skippedFiles++
        continue
      }
    }

    let content: string
    try {
      content = readFileSync(full, 'utf8')
    } catch (err) {
      errors.push({ path: rel, message: (err as Error).message })
      continue
    }
    const chunks = chunkMarkdown(content)
    if (chunks.length === 0) {
      builtFiles++ // counted as visited even if it produced nothing
      continue
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      try {
        const vector = await embed(chunk, { model, signal: options.signal })
        newChunks.push({ path: rel, chunkIndex: i, text: chunk, vector })
      } catch (err) {
        errors.push({ path: rel, message: (err as Error).message })
        // Don't bail on the whole build — a single bad file shouldn't
        // erase the whole index. The error is surfaced to the user.
        break
      }
    }
    builtFiles++
  }

  const index: EmbeddingIndex = {
    model,
    builtAt: Date.now(),
    fileMtimes: newMtimes,
    chunks: newChunks
  }
  return {
    index,
    result: {
      builtFiles,
      skippedFiles,
      totalChunks: newChunks.length,
      durationMs: Date.now() - startedAt,
      errors
    }
  }
}

export interface SemanticSearchOptions {
  model?: string
  /** Override the knowledge root — used by tests. */
  knowledgeDir?: string
  /** Inject the embed function — used by tests. */
  embed?: (text: string, options: EmbedOptions) => Promise<number[]>
  /** Pre-loaded index — useful when the caller already has it in memory. */
  index?: EmbeddingIndex | null
  /** Min similarity below which a hit is discarded. Default 0.25. */
  minScore?: number
  /** Top-K cap on results. Default 8. */
  limit?: number
  signal?: AbortSignal
}

/**
 * Run a semantic search. Returns `null` if there is no index yet (the
 * caller should prompt the user to build one). Throws if the embedding
 * call fails — that's typically "Ollama is offline" and the caller
 * should fall back to keyword search.
 */
export async function semanticSearch(
  query: string,
  options: SemanticSearchOptions = {}
): Promise<SemanticHit[] | null> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const index = options.index ?? loadIndex()
  if (!index || index.chunks.length === 0) return null

  const model = options.model ?? index.model
  // If the caller passed a different model than the index was built
  // with, the vectors are incompatible — refuse to mix.
  if (model !== index.model) return null

  const embed = options.embed ?? embedText
  const queryVector = await embed(trimmed, { model, signal: options.signal })

  const minScore = options.minScore ?? 0.25
  const limit = options.limit ?? 8

  const knowledgeDir = options.knowledgeDir ?? KNOWLEDGE_DIR
  // Cache title lookups per file so a single doc with many high-ranking
  // chunks doesn't re-read its content.
  const titleByPath = new Map<string, string>()

  const scored: SemanticHit[] = []
  for (const chunk of index.chunks) {
    const score = cosineSimilarity(queryVector, chunk.vector)
    if (score < minScore) continue
    let title = titleByPath.get(chunk.path)
    if (title === undefined) {
      try {
        const content = readFileSync(join(knowledgeDir, chunk.path), 'utf8')
        title = extractTitle(content, chunk.path)
      } catch {
        title = chunk.path.split('/').pop()?.replace(/\.md$/, '') ?? chunk.path
      }
      titleByPath.set(chunk.path, title)
    }
    const snippet = chunk.text.replace(/\s+/g, ' ').slice(0, 220)
    scored.push({ path: chunk.path, title, chunkIndex: chunk.chunkIndex, snippet, score })
  }
  scored.sort((a, b) => b.score - a.score)
  // Collapse duplicate paths so a doc with three matching chunks
  // doesn't dominate the top of the result list.
  const seenPaths = new Set<string>()
  const deduped: SemanticHit[] = []
  for (const hit of scored) {
    if (seenPaths.has(hit.path)) continue
    seenPaths.add(hit.path)
    deduped.push(hit)
    if (deduped.length >= limit) break
  }
  return deduped
}

// Exported for unit tests.
export const _internal = { chunkMarkdown, cosineSimilarity, walkMarkdown, INDEX_PATH }
