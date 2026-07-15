/**
 * Tests for the subscription web-enrichment IPC orchestrator. Real in-memory
 * SQLite (so `applySubscriptionWebEnrichment` is exercised for real against
 * the subscriptions table) with the LLM client and key vault mocked —
 * nothing leaves the process. Mirrors place-web-enrich.test.ts; the
 * invariants under test are the security-relevant ones:
 *   - the run writes NOTHING; only apply does, and only by id against the
 *     main-process cached run (renderer can't inject values)
 *   - `pause_turn` resends the assistant turn verbatim
 *   - a missing Anthropic key short-circuits before any LLM call
 *   - the outbound payload is name/category/cost/cadence only — never notes
 *     or payment account
 *   - `cancelUrl` is only patched when a `cancellationUrl` proposal is
 *     explicitly accepted
 *   - a linked merchant's `places.url` is passed as a search hint
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { LlmRequest, LlmResponse } from '../integrations/llm-client'
import type { SubscriptionWebEnrichProposal } from '../lib/subscription-web-enrichment'

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

const DDL = `
  CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'monthly', category TEXT,
    status TEXT NOT NULL DEFAULT 'active', next_renewal TEXT, trial_ends_at TEXT,
    payment_account TEXT, cancel_url TEXT, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', meta TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE places (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'merchant',
    name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER, meta TEXT
  );
  CREATE TABLE finance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
    amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', description TEXT NOT NULL,
    account_id INTEGER, category TEXT DEFAULT 'Uncategorized', subcategory TEXT, notes TEXT,
    geo TEXT NOT NULL DEFAULT 'US', purpose TEXT, tax_tag TEXT NOT NULL DEFAULT 'tax:none',
    tax_tag_source TEXT NOT NULL DEFAULT 'auto', tax_year INTEGER,
    normalized_merchant TEXT, source_file TEXT, ingested_at INTEGER
  );
  CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
    occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
    dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
    mime_type TEXT, byte_size INTEGER, sha256 TEXT NOT NULL UNIQUE, stored_path TEXT NOT NULL,
    extracted_text TEXT, page_count INTEGER, doc_date TEXT, category TEXT, notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE document_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id),
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER
  );
`

function addSubscription(over: {
  name: string
  cost?: number
  cadence?: string
  category?: string
  notes?: string
  paymentAccount?: string
}): number {
  const info = sqlite
    .prepare(
      `INSERT INTO subscriptions (external_id, name, cost, cadence, category, notes, payment_account)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `manual:${over.name}`,
      over.name,
      over.cost ?? 15.49,
      over.cadence ?? 'monthly',
      over.category ?? null,
      over.notes ?? null,
      over.paymentAccount ?? null
    )
  return Number(info.lastInsertRowid)
}

function subscriptionRow(id: number): Record<string, unknown> {
  return sqlite.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Record<
    string,
    unknown
  >
}

const AUTH = { provider: 'anthropic', key: 'sk-ant-test', model: undefined }

/** A full happy-path Anthropic response: one search + the submit tool call. */
function foundResponse(): LlmResponse {
  return {
    text: '',
    model: 'claude-test',
    inputTokens: 100,
    outputTokens: 50,
    stopReason: 'tool_use',
    toolUses: [
      {
        id: 'tu1',
        name: 'submit_subscription_findings',
        input: {
          outcome: 'found',
          matchConfidence: 'high',
          match: {
            pricingSummary: {
              value: '$15.49/month',
              sourceUrl: 'https://netflix.com/signup/plans',
              confidence: 'high'
            },
            cancellationUrl: {
              value: 'https://netflix.com/cancelplan',
              sourceUrl: 'https://netflix.com/cancelplan',
              confidence: 'high'
            },
            cancellationSteps: {
              value: '1. Go to Account. 2. Cancel Membership.',
              sourceUrl: 'https://netflix.com/cancelplan',
              confidence: 'high'
            },
            alternatives: [
              { name: 'Max', note: 'More live sports', sourceUrl: 'https://madeup.example/x' }
            ]
          }
        }
      }
    ],
    rawContent: [
      {
        type: 'server_tool_use',
        id: 'st1',
        name: 'web_search',
        input: { query: 'netflix pricing cancel' }
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'st1',
        content: [
          { type: 'web_search_result', url: 'https://netflix.com/signup/plans', title: 'Plans' },
          {
            type: 'web_search_result',
            url: 'https://netflix.com/cancelplan',
            title: 'Cancel your plan'
          }
        ]
      },
      { type: 'tool_use', id: 'tu1', name: 'submit_subscription_findings', input: {} }
    ]
  }
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(DDL)
  for (const k of Object.keys(handlers)) delete handlers[k]
  callLlm.mockReset()
  readKeyInternal.mockReset()
  readKeyInternal.mockReturnValue(AUTH)
  const mod = await import('./subscription-web-enrich')
  mod.registerSubscriptionWebEnrichHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('subscriptions:web-enrich', () => {
  it('rejects bad payloads without calling the LLM', async () => {
    expect(await invoke('subscriptions:web-enrich', null)).toMatchObject({ success: false })
    expect(await invoke('subscriptions:web-enrich', { subscriptionId: 'x' })).toMatchObject({
      success: false
    })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('short-circuits with needsKey before any LLM call', async () => {
    readKeyInternal.mockReturnValue(null)
    const id = addSubscription({ name: 'Netflix' })
    expect(await invoke('subscriptions:web-enrich', { subscriptionId: id })).toMatchObject({
      success: false,
      needsKey: true
    })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('returns proposals and writes NOTHING until apply', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addSubscription({ name: 'Netflix' })
    const r = (await invoke('subscriptions:web-enrich', { subscriptionId: id })) as {
      success: boolean
      outcome: string
      runId: string
      proposals: SubscriptionWebEnrichProposal[]
    }
    expect(r).toMatchObject({ success: true, outcome: 'proposals' })
    expect(r.proposals.length).toBeGreaterThanOrEqual(3)
    // The verified citation is checked; the made-up one is not.
    const alt = r.proposals.find((p) => p.kind === 'alternative')
    expect(alt?.sourceVerified).toBe(false)
    // No writes yet.
    const row = subscriptionRow(id)
    expect(row.cancel_url).toBeNull()
    expect(row.meta).toBeNull()
  })

  it('sends name/category/cost/cadence only — never notes or payment account', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addSubscription({
      name: 'Netflix',
      category: 'Streaming',
      notes: 'my secret notes',
      paymentAccount: 'Chase Checking 1234'
    })
    await invoke('subscriptions:web-enrich', { subscriptionId: id, hints: 'the standard plan' })
    const req = callLlm.mock.calls[0][0]
    const userMsg = JSON.stringify(req.messages)
    expect(userMsg).toContain('Netflix')
    expect(userMsg).toContain('Streaming')
    expect(userMsg).toContain('the standard plan')
    expect(userMsg).not.toContain('secret notes')
    expect(userMsg).not.toContain('Chase Checking')
  })

  it("passes a linked merchant's url as a known-site hint", async () => {
    callLlm.mockResolvedValue(foundResponse())
    sqlite
      .prepare(
        "INSERT INTO places (external_id, kind, name, url, source) VALUES ('derived:merchant:netflix', 'merchant', 'Netflix', 'https://netflix.com', 'derived')"
      )
      .run()
    const id = addSubscription({ name: 'Netflix' })
    await invoke('subscriptions:web-enrich', { subscriptionId: id })
    const req = callLlm.mock.calls[0][0]
    const userMsg = JSON.stringify(req.messages)
    expect(userMsg).toContain('Known official site: https://netflix.com')
  })

  it('resends the assistant turn verbatim on pause_turn', async () => {
    const paused: LlmResponse = {
      text: '',
      model: 'claude-test',
      stopReason: 'pause_turn',
      rawContent: [{ type: 'server_tool_use', id: 'st0', name: 'web_search', input: {} }]
    }
    callLlm.mockResolvedValueOnce(paused).mockResolvedValueOnce(foundResponse())
    const id = addSubscription({ name: 'Netflix' })
    const r = (await invoke('subscriptions:web-enrich', { subscriptionId: id })) as {
      outcome: string
    }
    expect(r.outcome).toBe('proposals')
    expect(callLlm).toHaveBeenCalledTimes(2)
    const second = callLlm.mock.calls[1][0]
    expect(second.messages[1]).toEqual({ role: 'assistant', content: paused.rawContent })
  })
})

describe('subscriptions:web-enrich-apply', () => {
  async function runToProposals(id: number): Promise<{
    runId: string
    proposals: SubscriptionWebEnrichProposal[]
  }> {
    callLlm.mockResolvedValue(foundResponse())
    return (await invoke('subscriptions:web-enrich', { subscriptionId: id })) as {
      runId: string
      proposals: SubscriptionWebEnrichProposal[]
    }
  }

  it('applies an accepted cancellationUrl + web namespace, preserving other meta', async () => {
    const id = addSubscription({ name: 'Netflix' })
    sqlite
      .prepare('UPDATE subscriptions SET meta = ? WHERE id = ?')
      .run(JSON.stringify({ usage: { rating: 'love', ratedAt: 1 } }), id)
    const { runId, proposals } = await runToProposals(id)
    const accepted = proposals.map((p) => p.id) // accept everything

    const r = await invoke('subscriptions:web-enrich-apply', { runId, accepted })
    expect(r).toMatchObject({ success: true })
    const row = subscriptionRow(id)
    expect(row.cancel_url).toBe('https://netflix.com/cancelplan')
    const meta = JSON.parse(row.meta as string)
    expect(meta.usage.rating).toBe('love') // untouched
    expect(meta.enrichment.web.pricingSummary).toBe('$15.49/month')
    expect(meta.enrichment.web.cancellationSteps).toContain('Cancel Membership')
    expect(meta.enrichment.web.alternatives).toHaveLength(1)
    expect(meta.enrichment.web.sources).toHaveLength(2)
  })

  it('does NOT patch cancelUrl unless the cancellationUrl proposal was accepted', async () => {
    const id = addSubscription({ name: 'Netflix' })
    const { runId, proposals } = await runToProposals(id)
    const nonUrlIds = proposals.filter((p) => p.kind !== 'cancellationUrl').map((p) => p.id)

    await invoke('subscriptions:web-enrich-apply', { runId, accepted: nonUrlIds })
    const row = subscriptionRow(id)
    expect(row.cancel_url).toBeNull()
    const meta = JSON.parse(row.meta as string)
    expect(meta.enrichment.web.cancellationUrl).toBeNull() // not accepted → not persisted either
    expect(meta.enrichment.web.pricingSummary).toBe('$15.49/month') // still persisted
  })

  it('rejects a stale/unknown runId and empty acceptance applies nothing to columns', async () => {
    const id = addSubscription({ name: 'Netflix' })
    const { runId } = await runToProposals(id)
    expect(
      await invoke('subscriptions:web-enrich-apply', { runId: 'nope', accepted: [0] })
    ).toMatchObject({ success: false })
    const r = await invoke('subscriptions:web-enrich-apply', { runId, accepted: [] })
    expect(r).toMatchObject({ success: true })
    expect(subscriptionRow(id).cancel_url).toBeNull()
  })

  it('cancel discards the cached run', async () => {
    const id = addSubscription({ name: 'Netflix' })
    const { runId } = await runToProposals(id)
    await invoke('subscriptions:web-enrich-cancel')
    expect(await invoke('subscriptions:web-enrich-apply', { runId, accepted: [0] })).toMatchObject({
      success: false
    })
  })
})
