/**
 * Tests for the web-enrichment IPC orchestrator. Real in-memory SQLite (so
 * `applyWebEnrichment` is exercised for real against the contacts table) with
 * the LLM client and key vault mocked — nothing leaves the process.
 *
 * The invariants under test are the security-relevant ones:
 *   - the run writes NOTHING; only apply does, and only by id against the
 *     main-process cached run (renderer can't inject values)
 *   - `pause_turn` resends the assistant turn verbatim
 *   - a missing Anthropic key short-circuits before any LLM call
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { LlmRequest, LlmResponse } from '../integrations/llm-client'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))
vi.mock('../knowledge/contacts-extractor', () => ({ writeRelationships: vi.fn() }))
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

const CONTACTS_DDL = `CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT, org TEXT, job_title TEXT,
  phones TEXT, emails TEXT, addresses TEXT, birthday TEXT, url TEXT, relationship TEXT, notes TEXT, photo TEXT,
  source TEXT NOT NULL DEFAULT 'manual', search_blob TEXT, enrichment TEXT, created_at INTEGER, updated_at INTEGER
);`

function addContact(over: {
  displayName: string
  org?: string
  jobTitle?: string
  enrichment?: string
}): number {
  const info = sqlite
    .prepare(
      'INSERT INTO contacts (external_id, display_name, org, job_title, enrichment, emails, phones) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      `test/${over.displayName}`,
      over.displayName,
      over.org ?? null,
      over.jobTitle ?? null,
      over.enrichment ?? null,
      '[]',
      '[]'
    )
  return Number(info.lastInsertRowid)
}

function contactRow(id: number): Record<string, unknown> {
  return sqlite.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Record<string, unknown>
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
        name: 'submit_web_findings',
        input: {
          outcome: 'found',
          matchConfidence: 'high',
          match: {
            jobTitle: {
              value: 'VP Engineering',
              sourceUrl: 'https://acme.com/team',
              confidence: 'high'
            },
            org: { value: 'Acme Corp', sourceUrl: 'https://acme.com/team', confidence: 'high' },
            links: [
              {
                type: 'github',
                value: 'https://github.com/jane',
                sourceUrl: 'https://github.com/jane'
              }
            ],
            facts: [
              { text: 'Spoke at PyCon', sourceUrl: 'https://madeup.example/x', confidence: 'low' }
            ]
          }
        }
      }
    ],
    rawContent: [
      { type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'jane doe acme' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'st1',
        content: [
          { type: 'web_search_result', url: 'https://acme.com/team', title: 'Team' },
          { type: 'web_search_result', url: 'https://github.com/jane', title: 'GitHub' }
        ]
      },
      { type: 'tool_use', id: 'tu1', name: 'submit_web_findings', input: {} }
    ]
  }
}

beforeEach(async () => {
  sqlite = new Database(':memory:')
  sqlite.exec(CONTACTS_DDL)
  for (const k of Object.keys(handlers)) delete handlers[k]
  callLlm.mockReset()
  readKeyInternal.mockReset()
  readKeyInternal.mockReturnValue(AUTH)
  const mod = await import('./contact-web-enrich')
  mod.registerContactWebEnrichHandlers(fakeIpcMain as IpcMain)
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('contacts:web-enrich', () => {
  it('rejects bad payloads without calling the LLM', async () => {
    expect(await invoke('contacts:web-enrich', null)).toMatchObject({ success: false })
    expect(await invoke('contacts:web-enrich', { contactId: 'x' })).toMatchObject({
      success: false
    })
    expect(await invoke('contacts:web-enrich', { contactId: 1.5 })).toMatchObject({
      success: false
    })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('returns needsKey without an LLM call when no Anthropic key is stored', async () => {
    readKeyInternal.mockReturnValue(null)
    const id = addContact({ displayName: 'Jane Doe' })
    const r = await invoke('contacts:web-enrich', { contactId: id })
    expect(r).toMatchObject({ success: false, needsKey: true })
    expect(callLlm).not.toHaveBeenCalled()
  })

  it('happy path: returns verified proposals and writes NOTHING', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addContact({ displayName: 'Jane Doe', org: 'Old Org' })

    const r = (await invoke('contacts:web-enrich', {
      contactId: id,
      hints: 'lives in Austin'
    })) as {
      success: boolean
      outcome: string
      runId: string
      searchedAs: string
      searchCount: number
      proposals: Array<Record<string, unknown>>
    }
    expect(r.success).toBe(true)
    expect(r.outcome).toBe('proposals')
    expect(r.searchedAs).toBe('Jane Doe (Old Org) — lives in Austin')
    expect(r.searchCount).toBe(1)
    const kinds = r.proposals.map((p) => p.kind)
    expect(kinds).toEqual(['jobTitle', 'org', 'link', 'fact'])
    expect(r.proposals.find((p) => p.kind === 'jobTitle')?.sourceVerified).toBe(true)
    expect(r.proposals.find((p) => p.kind === 'fact')?.sourceVerified).toBe(false)

    // The tools + identity went out; emails/phones did not.
    const req = callLlm.mock.calls[0][0]
    expect(req.provider).toBe('anthropic')
    expect(req.tools?.some((t) => 'type' in t && t.type === 'web_search_20250305')).toBe(true)
    expect(JSON.stringify(req.messages)).not.toContain('@')

    // Nothing written until apply.
    const row = contactRow(id)
    expect(row.job_title).toBeNull()
    expect(row.org).toBe('Old Org')
    expect(row.enrichment).toBeNull()
  })

  it('resends the assistant turn verbatim on pause_turn', async () => {
    const paused: LlmResponse = {
      text: '',
      model: 'claude-test',
      stopReason: 'pause_turn',
      rawContent: [
        { type: 'server_tool_use', id: 'st0', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 'st0', content: [] }
      ]
    }
    callLlm.mockResolvedValueOnce(paused).mockResolvedValueOnce(foundResponse())
    const id = addContact({ displayName: 'Jane Doe' })

    const r = (await invoke('contacts:web-enrich', { contactId: id })) as {
      outcome: string
      searchCount: number
    }
    expect(r.outcome).toBe('proposals')
    expect(callLlm).toHaveBeenCalledTimes(2)
    const second = callLlm.mock.calls[1][0]
    expect(second.messages).toHaveLength(2)
    expect(second.messages[1]).toEqual({ role: 'assistant', content: paused.rawContent })
    // server_tool_use blocks from BOTH passes counted.
    expect(r.searchCount).toBe(2)
  })

  it('surfaces disambiguation candidates', async () => {
    callLlm.mockResolvedValue({
      text: '',
      model: 'm',
      stopReason: 'tool_use',
      toolUses: [
        {
          id: 't',
          name: 'submit_web_findings',
          input: {
            outcome: 'ambiguous',
            matchConfidence: 'low',
            candidates: [
              { name: 'Jane Doe', descriptor: 'VP at Acme, Austin' },
              { name: 'Jane Doe', descriptor: 'Painter in Berlin' }
            ]
          }
        }
      ]
    })
    const id = addContact({ displayName: 'Jane Doe' })
    const r = (await invoke('contacts:web-enrich', { contactId: id })) as {
      outcome: string
      candidates: unknown[]
    }
    expect(r.outcome).toBe('candidates')
    expect(r.candidates).toHaveLength(2)
  })

  it('salvages prose output via the text fallback', async () => {
    callLlm.mockResolvedValue({
      text: 'Findings: {"outcome":"found","matchConfidence":"medium","match":{"org":{"value":"Acme","confidence":"high"}}}',
      model: 'm',
      stopReason: 'end_turn'
    })
    const id = addContact({ displayName: 'Jane Doe' })
    const r = (await invoke('contacts:web-enrich', { contactId: id })) as {
      outcome: string
      proposals: Array<{ kind: string }>
    }
    expect(r.outcome).toBe('proposals')
    expect(r.proposals.map((p) => p.kind)).toEqual(['org'])
  })

  it('maps an aborted run to cancelled', async () => {
    const { LlmAbortError } = await import('../integrations/llm-client')
    callLlm.mockRejectedValue(new LlmAbortError())
    const id = addContact({ displayName: 'Jane Doe' })
    const r = await invoke('contacts:web-enrich', { contactId: id })
    expect(r).toMatchObject({ success: false, cancelled: true })
  })

  it('reports not_found as a friendly empty outcome', async () => {
    callLlm.mockResolvedValue({
      text: '',
      model: 'm',
      stopReason: 'tool_use',
      toolUses: [
        {
          id: 't',
          name: 'submit_web_findings',
          input: { outcome: 'not_found', matchConfidence: 'low' }
        }
      ]
    })
    const id = addContact({ displayName: 'Total Ghost' })
    const r = await invoke('contacts:web-enrich', { contactId: id })
    expect(r).toMatchObject({ success: true, outcome: 'none' })
  })
})

describe('contacts:web-enrich-apply', () => {
  it('applies only the accepted ids and preserves other enrichment namespaces', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addContact({
      displayName: 'Jane Doe',
      org: 'Old Org',
      enrichment: JSON.stringify({ google: { nicknames: ['JJ'] } })
    })
    const run = (await invoke('contacts:web-enrich', { contactId: id })) as {
      runId: string
      proposals: Array<{ id: number; kind: string }>
    }
    // Accept jobTitle + org + link; reject the (unverified) fact.
    const accepted = run.proposals.filter((p) => p.kind !== 'fact').map((p) => p.id)
    const r = (await invoke('contacts:web-enrich-apply', {
      runId: run.runId,
      accepted
    })) as { success: boolean; applied: { fields: string[]; findings: number } }
    expect(r.success).toBe(true)
    expect(r.applied.fields.sort()).toEqual(['jobTitle', 'org'])
    expect(r.applied.findings).toBe(1) // the link

    const row = contactRow(id)
    expect(row.job_title).toBe('VP Engineering')
    expect(row.org).toBe('Acme Corp')
    // org changed → search blob recomputed with the new org.
    expect(String(row.search_blob)).toContain('acme corp')
    const enr = JSON.parse(String(row.enrichment)) as {
      google?: { nicknames: string[] }
      web?: { links: unknown[]; facts: unknown[]; sources: unknown[]; searchedAs: string }
    }
    expect(enr.google?.nicknames).toEqual(['JJ']) // untouched
    expect(enr.web?.links).toHaveLength(1)
    expect(enr.web?.facts).toHaveLength(0) // rejected
    expect(enr.web?.sources).toHaveLength(2) // ground truth always kept
  })

  it('rejects an unknown or stale runId and double-applies', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addContact({ displayName: 'Jane Doe' })
    const run = (await invoke('contacts:web-enrich', { contactId: id })) as { runId: string }

    expect(
      await invoke('contacts:web-enrich-apply', { runId: 'nope', accepted: [0] })
    ).toMatchObject({ success: false })

    expect(
      (await invoke('contacts:web-enrich-apply', { runId: run.runId, accepted: [0] })) as {
        success: boolean
      }
    ).toMatchObject({ success: true })
    // The run is single-use — a second apply must fail.
    expect(
      await invoke('contacts:web-enrich-apply', { runId: run.runId, accepted: [0] })
    ).toMatchObject({ success: false })
  })

  it('cancel invalidates the cached run — a discarded review can never apply', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addContact({ displayName: 'Jane Doe' })
    const run = (await invoke('contacts:web-enrich', { contactId: id })) as { runId: string }

    // "Discard"/close → cancel, even with nothing in flight, must succeed…
    expect(await invoke('contacts:web-enrich-cancel')).toEqual({ success: true })
    // …and the stale runId must no longer be applyable.
    expect(
      await invoke('contacts:web-enrich-apply', { runId: run.runId, accepted: [0] })
    ).toMatchObject({ success: false })
    const row = contactRow(id)
    expect(row.job_title).toBeNull()
    expect(row.enrichment).toBeNull()
  })

  it('caps a renderer-supplied accepted array before doing any work', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addContact({ displayName: 'Jane Doe' })
    const run = (await invoke('contacts:web-enrich', { contactId: id })) as {
      runId: string
      proposals: Array<{ id: number; kind: string }>
    }
    // A huge hostile array still succeeds; ids beyond the cap are dropped, but
    // the real proposal ids sit at the front so the apply is unaffected.
    const jobTitleId = run.proposals.find((p) => p.kind === 'jobTitle')?.id as number
    const huge = [jobTitleId, ...Array.from({ length: 100_000 }, (_, i) => i + 1000)]
    const r = (await invoke('contacts:web-enrich-apply', {
      runId: run.runId,
      accepted: huge
    })) as { success: boolean; applied: { fields: string[] } }
    expect(r.success).toBe(true)
    expect(r.applied.fields).toEqual(['jobTitle'])
  })

  it('ignores non-integer accepted ids (renderer cannot smuggle values)', async () => {
    callLlm.mockResolvedValue(foundResponse())
    const id = addContact({ displayName: 'Jane Doe' })
    const run = (await invoke('contacts:web-enrich', { contactId: id })) as { runId: string }
    const r = (await invoke('contacts:web-enrich-apply', {
      runId: run.runId,
      accepted: ['0', { evil: true }, 1.5, null]
    })) as { success: boolean; applied: { fields: string[]; findings: number } }
    // All bogus ids filtered → applies nothing, but the namespace still records the run.
    expect(r.success).toBe(true)
    expect(r.applied.fields).toEqual([])
    expect(r.applied.findings).toBe(0)
    const row = contactRow(id)
    expect(row.job_title).toBeNull()
  })
})
