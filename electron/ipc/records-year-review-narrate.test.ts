/**
 * Year in Review narration IPC (Timeline 2.1) — the opt-in cloud path. Mocks
 * the LLM client + assistant vault so no network happens: proves the gate
 * (off / no-key), a happy path (returns provider prose), graceful failure
 * (falls back to `ok:false`, template preserved by the caller), and that the
 * markdown export honors the displayed narrative override.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database
vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('../knowledge/records-extractor', () => ({ updateRecordsKnowledge: vi.fn() }))
vi.mock('../knowledge/records-embeddings', () => ({
  loadRecordsIndex: () => null,
  saveRecordsIndex: vi.fn(),
  buildRecordsEmbeddingsIndex: vi.fn(),
  searchRecordsSemantic: vi.fn(async () => null)
}))
vi.mock('../integrations/location-residency', () => ({ afterLocationImport: vi.fn() }))

// The LLM boundary — swapped per-test so no request ever leaves the process.
const callLlm = vi.fn()
vi.mock('../integrations/llm-client', async () => {
  const actual = await vi.importActual<typeof import('../integrations/llm-client')>(
    '../integrations/llm-client'
  )
  return { ...actual, callLlm: (...args: unknown[]) => callLlm(...args) }
})
const readActiveKeyInternal = vi.fn()
vi.mock('../integrations/assistant-vault', () => ({
  readActiveKeyInternal: () => readActiveKeyInternal()
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve().then(() => handlers[channel]({}, ...args))

function setNarration(on: boolean): void {
  sqlite
    .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run('yearReviewNarrationEnabled', on ? 'true' : 'false')
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
  `)
  // A real event so buildYearReview has something to narrate.
  // Two watches of the same title so it surfaces as a repeated "top title"
  // (single-play titles are deliberately excluded from the recap).
  sqlite
    .prepare(
      "INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES ('netflix', 'watch', ?, 'Severance S1E1', 'seed1')"
    )
    .run(Date.parse('2024-02-11T20:00:00Z'))
  sqlite
    .prepare(
      "INSERT INTO records (source, type, occurred_at, title, dedup_hash) VALUES ('netflix', 'watch', ?, 'Severance S1E1', 'seed2')"
    )
    .run(Date.parse('2024-02-12T20:00:00Z'))
  for (const k of Object.keys(handlers)) delete handlers[k]
  callLlm.mockReset()
  readActiveKeyInternal.mockReset()
  const mod = await import('./records')
  mod.registerRecordsHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('records:year-review-narrate', () => {
  it('is a no-op (no LLM call) when narration is disabled', async () => {
    setNarration(false)
    readActiveKeyInternal.mockReturnValue({
      provider: 'anthropic',
      key: 'sk-ant-x',
      model: undefined
    })
    const res = (await invoke('records:year-review-narrate', { year: 2024 })) as {
      ok: boolean
      reason: string
    }
    expect(res).toEqual({ ok: false, reason: 'off' })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('returns no-key without calling the LLM when no provider is configured', async () => {
    setNarration(true)
    readActiveKeyInternal.mockReturnValue(null)
    const res = (await invoke('records:year-review-narrate', { year: 2024 })) as { reason: string }
    expect(res.reason).toBe('no-key')
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('narrates via the configured provider on the happy path', async () => {
    setNarration(true)
    readActiveKeyInternal.mockReturnValue({ provider: 'openai', key: 'sk-x', model: 'gpt-4o-mini' })
    callLlm.mockResolvedValue({
      text: '  2024 was a quiet, bingeable year.  ',
      model: 'gpt-4o-mini'
    })
    const res = (await invoke('records:year-review-narrate', { year: 2024 })) as {
      ok: boolean
      narrative: string
      provider: string
    }
    expect(res.ok).toBe(true)
    expect(res.narrative).toBe('2024 was a quiet, bingeable year.') // trimmed
    expect(res.provider).toBe('openai')
    // The aggregate went to the model, gated behind the opt-in.
    const arg = callLlm.mock.calls[0][0] as { messages: Array<{ content: string }> }
    expect(arg.messages[0].content).toContain('Severance S1E1')
  })

  it('degrades to ok:false on an LLM error (caller keeps the template)', async () => {
    setNarration(true)
    readActiveKeyInternal.mockReturnValue({
      provider: 'anthropic',
      key: 'sk-ant-x',
      model: undefined
    })
    callLlm.mockRejectedValue(new Error('429 rate limited'))
    const res = (await invoke('records:year-review-narrate', { year: 2024 })) as {
      ok: boolean
      reason: string
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('error')
  })

  it('exports the narrative override in the markdown (what the user sees)', async () => {
    const md = (await invoke('records:year-review-markdown', {
      year: 2024,
      narrative: 'A warm one-off recap.'
    })) as string
    expect(md).toContain('A warm one-off recap.')
  })
})
