/**
 * Semantic search over the records timeline (Phase 10.7 "Converse" PR2).
 *
 * Real in-memory SQLite + an INJECTED embed function (a tiny deterministic
 * bag-of-words vector) so the whole thing runs offline — no Ollama. Covers the
 * incremental-by-id build, model-change invalidation, hydrate + post-filtering,
 * and the null/empty "fall back to FTS" signals.
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EmbedOptions } from './embeddings'
import {
  buildRecordsEmbeddingsIndex,
  recordEmbedText,
  searchRecordsSemantic
} from './records-embeddings'

let sqlite: Database.Database

// Deterministic offline embedding: a fixed-dim vector counting a few keywords, so
// records that share words land near each other under cosine similarity.
const VOCAB = ['coffee', 'speaker', 'matrix', 'kindle', 'book', 'movie', 'music', 'order']
function fakeEmbed(text: string, _opts: EmbedOptions): Promise<number[]> {
  const lc = text.toLowerCase()
  const v: number[] = VOCAB.map((w) => (lc.includes(w) ? 1 : 0))
  // Avoid an all-zero vector (cosine undefined) by adding a tiny constant dim.
  v.push(0.01)
  return Promise.resolve(v)
}

function add(r: {
  source: string
  type: string
  title: string
  body?: string | null
  occurredAt?: number | null
}): void {
  sqlite
    .prepare(
      'INSERT INTO records (source,type,occurred_at,title,body,dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(r.source, r.type, r.occurredAt ?? null, r.title, r.body ?? null, `${r.source}|${r.title}`)
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
    title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
  );`)
})
afterEach(() => sqlite.close())

describe('recordEmbedText', () => {
  it('composes title — body (source, date)', () => {
    expect(
      recordEmbedText({
        title: 'Echo Dot',
        body: 'speaker',
        source: 'amazon',
        occurredAt: Date.UTC(2021, 2, 1)
      })
    ).toBe('Echo Dot — speaker (amazon, 2021-03-01)')
    expect(
      recordEmbedText({ title: 'Solo', body: null, source: 'netflix', occurredAt: null })
    ).toBe('Solo (netflix)')
  })
})

describe('buildRecordsEmbeddingsIndex (incremental)', () => {
  it('embeds all rows, then only NEW ids on a second pass', async () => {
    add({ source: 'amazon', type: 'order', title: 'Coffee beans' })
    add({ source: 'netflix', type: 'watch', title: 'The Matrix movie' })
    const first = await buildRecordsEmbeddingsIndex(sqlite, { embed: fakeEmbed, existing: null })
    expect(first.result.embedded).toBe(2)
    expect(first.index.maxId).toBe(2)
    expect(first.index.embeddings).toHaveLength(2)

    // A new record + an incremental build reusing the prior index → only id 3 embeds.
    add({ source: 'goodreads', type: 'book', title: 'Some book' })
    const second = await buildRecordsEmbeddingsIndex(sqlite, {
      embed: fakeEmbed,
      existing: first.index
    })
    expect(second.result.embedded).toBe(1) // only the new row
    expect(second.index.maxId).toBe(3)
    expect(second.index.embeddings).toHaveLength(3)
  })

  it('discards prior vectors when the model changes (no mixing)', async () => {
    add({ source: 'amazon', type: 'order', title: 'Coffee' })
    const a = await buildRecordsEmbeddingsIndex(sqlite, {
      embed: fakeEmbed,
      existing: null,
      model: 'model-a'
    })
    const b = await buildRecordsEmbeddingsIndex(sqlite, {
      embed: fakeEmbed,
      existing: a.index,
      model: 'model-b'
    })
    expect(b.index.model).toBe('model-b')
    expect(b.result.embedded).toBe(1) // re-embedded from scratch, not reused
  })

  it('honors the cap', async () => {
    for (let i = 0; i < 5; i++) add({ source: 'email', type: 'email', title: `Note ${i}` })
    const { index, result } = await buildRecordsEmbeddingsIndex(sqlite, {
      embed: fakeEmbed,
      cap: 3
    })
    expect(result.total).toBe(3)
    expect(index.embeddings).toHaveLength(3)
  })
})

describe('searchRecordsSemantic', () => {
  async function indexed() {
    add({
      source: 'amazon',
      type: 'order',
      title: 'Coffee beans',
      occurredAt: Date.UTC(2020, 0, 1)
    })
    add({
      source: 'netflix',
      type: 'watch',
      title: 'The Matrix movie',
      occurredAt: Date.UTC(2022, 0, 1)
    })
    add({
      source: 'venmo',
      type: 'payment',
      title: 'Coffee with Sam',
      occurredAt: Date.UTC(2024, 0, 1)
    })
    const { index } = await buildRecordsEmbeddingsIndex(sqlite, { embed: fakeEmbed })
    return index
  }

  it('ranks records by meaning (shared keywords land together)', async () => {
    const index = await indexed()
    const hits = await searchRecordsSemantic(sqlite, 'coffee', {
      embed: fakeEmbed,
      index,
      minScore: 0.1
    })
    expect(hits).not.toBeNull()
    expect(hits?.map((h) => h.title)).toEqual(['Coffee beans', 'Coffee with Sam'])
  })

  it('applies source / date post-filters', async () => {
    const index = await indexed()
    expect(
      (
        await searchRecordsSemantic(sqlite, 'coffee', {
          embed: fakeEmbed,
          index,
          minScore: 0.1,
          source: 'venmo'
        })
      )?.map((h) => h.title)
    ).toEqual(['Coffee with Sam'])
    expect(
      (
        await searchRecordsSemantic(sqlite, 'coffee', {
          embed: fakeEmbed,
          index,
          minScore: 0.1,
          from: Date.UTC(2023, 0, 1)
        })
      )?.map((h) => h.title)
    ).toEqual(['Coffee with Sam'])
  })

  it('returns null when there is no index (caller falls back to FTS)', async () => {
    expect(
      await searchRecordsSemantic(sqlite, 'coffee', { embed: fakeEmbed, index: null })
    ).toBeNull()
  })

  it('returns null when the query model differs from the index model', async () => {
    const index = await indexed()
    expect(
      await searchRecordsSemantic(sqlite, 'coffee', { embed: fakeEmbed, index, model: 'other' })
    ).toBeNull()
  })
})
