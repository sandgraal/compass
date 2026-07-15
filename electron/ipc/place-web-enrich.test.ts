/**
 * Tests for the place web-enrichment IPC orchestrator. Real in-memory SQLite
 * (so `applyPlaceWebEnrichment` is exercised for real against the places
 * table) with the LLM client and key vault mocked — nothing leaves the
 * process. Mirrors contact-web-enrich.test.ts; the invariants under test are
 * the security-relevant ones:
 *   - the run writes NOTHING; only apply does, and only by id against the
 *     main-process cached run (renderer can't inject values)
 *   - `pause_turn` resends the assistant turn verbatim
 *   - a missing Anthropic key short-circuits before any LLM call
 *   - the surface works for BOTH kinds (place + merchant rows)
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { LlmRequest, LlmResponse } from '../integrations/llm-client'
import type { PlaceWebEnrichProposal } from '../lib/place-web-enrichment'

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
  name TEXT NOT NULL, category TEXT, address TEXT, url TEXT, total_spend REAL, notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER, meta TEXT
);`

function addPlace(over: { name: string; kind?: string; category?: string }): number {
  const info = sqlite
    .prepare(
      "INSERT INTO places (external_id, kind, name, category, source) VALUES (?, ?, ?, ?, 'manual')"
    )
    .run(`manual/${over.name}`, over.kind ?? 'place', over.name, over.category ?? null)
  return Number(info.lastInsertRowid)
}

function placeRow(id: number): Record<string, unknown> {
  return sqlite.prepare('SELECT * FROM places WHERE id = ?').get(id) as Record<string, unknown>
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
        name: 'submit_place_findings',
        input: {
          outcome: 'found',
          matchConfidence: 'high',
          match: {
            category: {
              value: 'CrossFit gym',
              sourceUrl: 'https://crossfitcartago.cr',
              confidence: 'high'
            },
            url: {
              value: 'https://crossfitcartago.cr',
              sourceUrl: 'https://crossfitcartago.cr',
              confidence: 'high'
            },
            phone: {
              value: '+506 2551 0000',
              sourceUrl: 'https://crossfitcartago.cr',
              confidence: 'medium'
            },
            facts: [
              { text: 'Hosted nationals', sourceUrl: 'https://madeup.example/x', confidence: 'low' }
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
        input: { query: 'crossfit cartago' }
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'st1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://crossfitcartago.cr',
            title: 'CrossFit Cartago'
          }
        ]
      },
      { type: 'tool_use', id: 'tu1', name: 'submit_place_findings', input: {} }
    ]
  }
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(PLACES_DDL)
  for (const k of Object.keys(handlers)) delete handlers[k]
  callLlm.mockReset()
  readKeyInternal.mockReset()
  readKeyInternal.mockReturnValue(AUTH)
  const mod = await import('./place-web-enrich')
  mod.registerPlaceWebEnrichHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('places:web-enrich', () => {
  it('rejects bad payloads without calling the LLM', async () => {
    expect(await invoke('places:web-enrich', null)).toMatchObject({ success: false })
    expect(await invoke('places:web-enrich', { placeId: 'x' })).toMatchObject({ success: false })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('short-circuits with needsKey before any LLM call', async () => {
    readKeyInternal.mockReturnValue(null)
    const id = addPlace({ name: 'CrossFit Cartago' })
    expect(await invoke('places:web-enrich', { placeId: id })).toMatchObject({
      success: false,
      needsKey: true
    })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('returns proposals and writes NOTHING until apply', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addPlace({ name: 'CrossFit Cartago' })
    const r = (await invoke('places:web-enrich', { placeId: id })) as {
      success: boolean
      outcome: string
      runId: string
      proposals: PlaceWebEnrichProposal[]
    }
    expect(r).toMatchObject({ success: true, outcome: 'proposals' })
    expect(r.proposals.length).toBeGreaterThanOrEqual(3)
    // The verified citation is checked; the made-up one is not.
    const fact = r.proposals.find((p) => p.kind === 'fact')
    expect(fact?.sourceVerified).toBe(false)
    // No writes yet.
    const row = placeRow(id)
    expect(row.category).toBeNull()
    expect(row.meta).toBeNull()
  })

  it('sends name/category/address only — never notes', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addPlace({ name: 'CrossFit Cartago', category: 'Gym' })
    sqlite.prepare('UPDATE places SET notes = ? WHERE id = ?').run('my secret notes', id)
    await invoke('places:web-enrich', { placeId: id, hints: 'near the ruins' })
    const req = callLlm.mock.calls[0][0]
    const userMsg = JSON.stringify(req.messages)
    expect(userMsg).toContain('CrossFit Cartago')
    expect(userMsg).toContain('near the ruins')
    expect(userMsg).not.toContain('secret notes')
  })

  it('resends the assistant turn verbatim on pause_turn', async () => {
    const paused: LlmResponse = {
      text: '',
      model: 'claude-test',
      stopReason: 'pause_turn',
      rawContent: [{ type: 'server_tool_use', id: 'st0', name: 'web_search', input: {} }]
    }
    callLlm.mockResolvedValueOnce(paused).mockResolvedValueOnce(foundResponse())
    const id = addPlace({ name: 'CrossFit Cartago' })
    const r = (await invoke('places:web-enrich', { placeId: id })) as { outcome: string }
    expect(r.outcome).toBe('proposals')
    expect(callLlm).toHaveBeenCalledTimes(2)
    const second = callLlm.mock.calls[1][0]
    expect(second.messages[1]).toEqual({ role: 'assistant', content: paused.rawContent })
  })
})

describe('places:web-enrich-apply', () => {
  async function runToProposals(id: number): Promise<{
    runId: string
    proposals: PlaceWebEnrichProposal[]
  }> {
    callLlm.mockResolvedValue(foundResponse())
    return (await invoke('places:web-enrich', { placeId: id })) as {
      runId: string
      proposals: PlaceWebEnrichProposal[]
    }
  }

  it('applies accepted core fields + web namespace, preserving other meta', async () => {
    const id = addPlace({ name: 'CrossFit Cartago' })
    sqlite
      .prepare('UPDATE places SET meta = ? WHERE id = ?')
      .run(JSON.stringify({ geo: { lat: 9.86, lng: -83.92, visitCount: 3, computedAt: 1 } }), id)
    const { runId, proposals } = await runToProposals(id)
    const accepted = proposals.filter((p) => p.kind !== 'fact').map((p) => p.id)

    const r = await invoke('places:web-enrich-apply', { runId, accepted })
    expect(r).toMatchObject({ success: true })
    const row = placeRow(id)
    expect(row.category).toBe('CrossFit gym')
    expect(row.url).toBe('https://crossfitcartago.cr')
    const meta = JSON.parse(row.meta as string)
    expect(meta.geo.lat).toBe(9.86) // untouched
    expect(meta.enrichment.web.phone).toBe('+506 2551 0000')
    expect(meta.enrichment.web.facts).toEqual([]) // fact not accepted
    expect(meta.enrichment.web.sources).toHaveLength(1)
  })

  it('works for merchant rows too (the shared surface)', async () => {
    const id = addPlace({ name: 'CrossFit Cartago', kind: 'merchant' })
    const { runId, proposals } = await runToProposals(id)
    await invoke('places:web-enrich-apply', { runId, accepted: proposals.map((p) => p.id) })
    expect(placeRow(id).category).toBe('CrossFit gym')
  })

  it('rejects a stale/unknown runId and empty acceptance applies nothing to columns', async () => {
    const id = addPlace({ name: 'CrossFit Cartago' })
    const { runId } = await runToProposals(id)
    expect(await invoke('places:web-enrich-apply', { runId: 'nope', accepted: [0] })).toMatchObject(
      { success: false }
    )
    const r = await invoke('places:web-enrich-apply', { runId, accepted: [] })
    expect(r).toMatchObject({ success: true, applied: { fields: [], findings: 0 } })
    expect(placeRow(id).category).toBeNull()
  })

  it('an empty/bogus accepted array writes NOTHING — not even meta.enrichment.web', async () => {
    const id = addPlace({ name: 'CrossFit Cartago' })
    const { runId } = await runToProposals(id)
    await invoke('places:web-enrich-apply', { runId, accepted: [] })
    expect(placeRow(id).meta).toBeNull()
  })

  it('ids that name no proposal in this run are treated as no acceptance', async () => {
    const id = addPlace({ name: 'CrossFit Cartago' })
    const { runId } = await runToProposals(id)
    const r = await invoke('places:web-enrich-apply', { runId, accepted: [999, 1000] })
    expect(r).toMatchObject({ success: true, applied: { fields: [], findings: 0 } })
    expect(placeRow(id).meta).toBeNull()
  })

  it('a stale runId cannot be reused after a no-op apply discarded the run', async () => {
    const id = addPlace({ name: 'CrossFit Cartago' })
    const { runId, proposals } = await runToProposals(id)
    await invoke('places:web-enrich-apply', { runId, accepted: [] })
    // The run is gone even though nothing was written — can't come back and
    // accept for real against the same runId.
    const r = await invoke('places:web-enrich-apply', {
      runId,
      accepted: proposals.map((p) => p.id)
    })
    expect(r).toMatchObject({ success: false })
  })

  it('cancel discards the cached run', async () => {
    const id = addPlace({ name: 'CrossFit Cartago' })
    const { runId } = await runToProposals(id)
    await invoke('places:web-enrich-cancel')
    expect(await invoke('places:web-enrich-apply', { runId, accepted: [0] })).toMatchObject({
      success: false
    })
  })
})
