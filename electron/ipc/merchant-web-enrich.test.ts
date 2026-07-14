/**
 * Merchant web-enrichment IPC orchestrator — real in-memory SQLite (so
 * `applyMerchantWebEnrichment` is exercised for real against the places table)
 * with the LLM client and key vault mocked. Same security invariants as the
 * contacts sibling:
 *   - the run writes NOTHING; only apply does, and only by id against the
 *     main-process cached run (renderer can't inject values)
 *   - a missing Anthropic key short-circuits before any LLM call
 *   - cancel/discard invalidates the cached run
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { LlmRequest, LlmResponse } from '../integrations/llm-client'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema }),
  getRawSqlite: () => sqlite
}))
vi.mock('electron', () => ({ dialog: {} }))

const callLlm = vi.fn<(req: LlmRequest) => Promise<LlmResponse>>()
vi.mock('../integrations/llm-client', () => {
  class LlmAbortError extends Error {}
  return {
    callLlm: (req: LlmRequest) => callLlm(req),
    LlmAbortError
  }
})

const readKeyInternal = vi.fn()
vi.mock('../integrations/assistant-vault', () => ({
  readKeyInternal: (p: string) => readKeyInternal(p)
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return Promise.resolve().then(() => h({}, ...args))
}

const PLACES_DDL = `CREATE TABLE places (
  id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
  name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT, meta TEXT,
  source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
);`

function addMerchant(over?: { name?: string; category?: string; meta?: string }): number {
  const info = sqlite
    .prepare(
      "INSERT INTO places (external_id, kind, name, category, meta) VALUES (?, 'merchant', ?, ?, ?)"
    )
    .run(
      `derived:merchant:${(over?.name ?? 'Blue Bottle').toLowerCase()}`,
      over?.name ?? 'Blue Bottle',
      over?.category ?? null,
      over?.meta ?? null
    )
  return Number(info.lastInsertRowid)
}

/** A found-outcome LLM response with one record field + one web finding. */
function foundResponse(): LlmResponse {
  return {
    text: '',
    model: 'claude-test',
    stopReason: 'tool_use',
    inputTokens: 100,
    outputTokens: 50,
    toolUses: [
      {
        id: 'tu1',
        name: 'submit_merchant_findings',
        input: {
          outcome: 'found',
          matchConfidence: 'high',
          match: {
            url: {
              value: 'https://bluebottle.com',
              sourceUrl: 'https://bluebottle.com/about',
              confidence: 'high'
            },
            supportEmail: {
              value: 'help@bluebottle.com',
              sourceUrl: 'https://bluebottle.com/contact',
              confidence: 'high'
            },
            description: {
              value: 'Specialty coffee roaster.',
              sourceUrl: 'https://bluebottle.com/about',
              confidence: 'high'
            }
          }
        }
      }
    ],
    rawContent: [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://bluebottle.com/about', title: 'About' },
          { type: 'web_search_result', url: 'https://bluebottle.com/contact', title: 'Contact' }
        ]
      }
    ] as LlmResponse['rawContent']
  } as LlmResponse
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(PLACES_DDL)
  callLlm.mockReset()
  readKeyInternal.mockReset()
  readKeyInternal.mockReturnValue({ key: 'sk-test', model: 'claude-test' })
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.resetModules()
  const mod = await import('./merchant-web-enrich')
  mod.registerMerchantWebEnrichHandlers(fakeIpcMain as IpcMain)
})
afterEach(() => sqlite.close())

describe('merchants:web-enrich', () => {
  it('missing Anthropic key short-circuits before any LLM call', async () => {
    readKeyInternal.mockReturnValue(null)
    const id = addMerchant()
    const r = (await invoke('merchants:web-enrich', { merchantId: id })) as {
      success: boolean
      needsKey?: boolean
    }
    expect(r.success).toBe(false)
    expect(r.needsKey).toBe(true)
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('a found run returns proposals and writes NOTHING', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addMerchant()
    const r = (await invoke('merchants:web-enrich', { merchantId: id })) as {
      success: true
      outcome: string
      proposals: Array<{ kind: string; sourceVerified: boolean }>
      searchedAs: string
    }
    expect(r.outcome).toBe('proposals')
    expect(r.proposals.map((p) => p.kind).sort()).toEqual(['description', 'supportEmail', 'url'])
    expect(r.proposals.every((p) => p.sourceVerified)).toBe(true)
    const row = sqlite.prepare('SELECT url, meta FROM places WHERE id = ?').get(id) as {
      url: string | null
      meta: string | null
    }
    expect(row.url).toBeNull()
    expect(row.meta).toBeNull()
  })

  it('rejects a non-merchant place and a bad id', async () => {
    sqlite
      .prepare(
        "INSERT INTO places (external_id, kind, name) VALUES ('derived:place:p', 'place', 'Park')"
      )
      .run()
    const r = (await invoke('merchants:web-enrich', { merchantId: 1 })) as { success: boolean }
    expect(r.success).toBe(false)
    const r2 = (await invoke('merchants:web-enrich', { merchantId: 'x' })) as { success: boolean }
    expect(r2.success).toBe(false)
  })
})

describe('merchants:web-enrich-apply', () => {
  async function runToProposals(id: number): Promise<{ runId: string; ids: number[] }> {
    callLlm.mockResolvedValue(foundResponse())
    const r = (await invoke('merchants:web-enrich', { merchantId: id })) as {
      runId: string
      proposals: Array<{ id: number; kind: string }>
    }
    return { runId: r.runId, ids: r.proposals.map((p) => p.id) }
  }

  it('applies accepted proposals by id: columns, meta.support, meta.enrichment', async () => {
    const id = addMerchant({ meta: JSON.stringify({ support: { phone: '555' } }) })
    const { runId, ids } = await runToProposals(id)
    const r = (await invoke('merchants:web-enrich-apply', { runId, accepted: ids })) as {
      success: boolean
      applied?: { fields: string[]; findings: number }
    }
    expect(r.success).toBe(true)
    expect(r.applied?.fields.sort()).toEqual(['supportEmail', 'url'])
    expect(r.applied?.findings).toBe(1)
    const row = sqlite.prepare('SELECT url, meta FROM places WHERE id = ?').get(id) as {
      url: string
      meta: string
    }
    expect(row.url).toBe('https://bluebottle.com')
    const meta = JSON.parse(row.meta)
    expect(meta.support).toEqual({ phone: '555', email: 'help@bluebottle.com' }) // merged, not clobbered
    expect(meta.enrichment.description).toBe('Specialty coffee roaster.')
    expect(meta.enrichment.sources).toHaveLength(2) // sources always kept in full
  })

  it('rejecting everything still replaces the namespace but writes no fields', async () => {
    const id = addMerchant()
    const { runId } = await runToProposals(id)
    const r = (await invoke('merchants:web-enrich-apply', { runId, accepted: [] })) as {
      success: boolean
      applied?: { fields: string[] }
    }
    expect(r.success).toBe(true)
    expect(r.applied?.fields).toEqual([])
    const row = sqlite.prepare('SELECT url, meta FROM places WHERE id = ?').get(id) as {
      url: string | null
      meta: string
    }
    expect(row.url).toBeNull()
    expect(JSON.parse(row.meta).enrichment.description).toBeNull()
  })

  it('an unknown or reused runId is rejected', async () => {
    const id = addMerchant()
    const { runId, ids } = await runToProposals(id)
    expect(
      (
        (await invoke('merchants:web-enrich-apply', { runId: 'wrong', accepted: ids })) as {
          success: boolean
        }
      ).success
    ).toBe(false)
    await invoke('merchants:web-enrich-apply', { runId, accepted: ids })
    // Second apply with the same runId: the run was consumed.
    expect(
      (
        (await invoke('merchants:web-enrich-apply', { runId, accepted: ids })) as {
          success: boolean
        }
      ).success
    ).toBe(false)
  })

  it('cancel discards the cached run', async () => {
    const id = addMerchant()
    const { runId, ids } = await runToProposals(id)
    await invoke('merchants:web-enrich-cancel')
    const r = (await invoke('merchants:web-enrich-apply', { runId, accepted: ids })) as {
      success: boolean
    }
    expect(r.success).toBe(false)
  })
})
