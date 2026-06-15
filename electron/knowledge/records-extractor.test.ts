/**
 * Tests for the records → markdown summary (Phase 10.1). The pure builder is
 * tested directly; the DB wrapper is tested with in-memory SQLite + a mocked
 * writer so nothing touches the real knowledge base.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { buildRecordsOverviewMarkdown, updateRecordsKnowledge } from './records-extractor'
import { updateKnowledgeFile } from './writer'

let sqlite: Database.Database
vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))
vi.mock('../paths', () => ({ KNOWLEDGE_DIR: '/tmp/compass-test-knowledge' }))
vi.mock('./writer', () => ({ updateKnowledgeFile: vi.fn() }))

describe('buildRecordsOverviewMarkdown', () => {
  it('renders an empty state', () => {
    expect(buildRecordsOverviewMarkdown([], 'now')).toContain('No imported records yet')
  })

  it('summarises counts, span, and recents', () => {
    const md = buildRecordsOverviewMarkdown(
      [
        {
          source: 'netflix',
          type: 'watch',
          occurredAt: new Date('2026-01-02'),
          title: 'The Matrix'
        },
        { source: 'spotify', type: 'listen', occurredAt: new Date('2026-02-10'), title: 'Track A' },
        { source: 'spotify', type: 'listen', occurredAt: null, title: 'Undated track' }
      ],
      'now'
    )
    expect(md).toContain('**3** records')
    expect(md).toContain('**Span:** 2026-01-02 → 2026-02-10')
    expect(md).toContain('## By source')
    expect(md).toContain('**spotify** — 2')
    expect(md).toContain('## Most recent')
    expect(md).toContain('Track A')
  })
})

describe('updateRecordsKnowledge', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
        occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
        dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
      );
    `)
    vi.mocked(updateKnowledgeFile).mockReset()
  })

  it('writes timeline/overview.md from the table', () => {
    sqlite
      .prepare(
        "INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES ('netflix','watch',?,?,?)"
      )
      .run(Date.parse('2026-01-02'), 'The Matrix', 'h1')
    updateRecordsKnowledge()
    expect(vi.mocked(updateKnowledgeFile)).toHaveBeenCalledTimes(1)
    const [, relPath, content] = vi.mocked(updateKnowledgeFile).mock.calls[0]
    expect(relPath).toBe('timeline/overview.md')
    expect(content).toContain('The Matrix')
  })
})
