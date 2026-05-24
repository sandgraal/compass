/**
 * Tests for the Phase 8.5 agentic loop (`_internal.runAgent` in assistant.ts).
 *
 * We mock the DB client (in-memory SQLite for the tools) and global `fetch`
 * (scripted Anthropic responses) so the full read→tool→propose→answer loop is
 * exercised without a network or real key.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

import { _internal } from './assistant'

const { runAgent } = _internal as unknown as {
  runAgent: (
    auth: { provider: 'anthropic'; key: string; model?: string },
    question: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    signal: AbortSignal
  ) => Promise<{
    answer: string
    model: string
    toolCalls: Array<{ name: string; ok: boolean }>
    proposalIds: string[]
  }>
}

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
  sqlite.close()
})

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, list_type TEXT NOT NULL, list_date TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, checked INTEGER DEFAULT 0, status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal', sort_order INTEGER DEFAULT 0, due_date TEXT,
      source TEXT DEFAULT 'manual', source_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, source_id TEXT, title TEXT,
      start_at INTEGER, end_at INTEGER, all_day INTEGER, location TEXT, description TEXT, url TEXT, created_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, is_debt INTEGER DEFAULT 0,
      asset_class TEXT, balance REAL, payment_due_date TEXT
    );
    CREATE TABLE finance_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, amount REAL, category TEXT);
    CREATE TABLE claude_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      payload TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'claude-mcp', status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, ingested_at INTEGER NOT NULL, resolved_at INTEGER, error TEXT,
      result_ref TEXT, cleared_at INTEGER
    );
  `)
})

/** Queue scripted Anthropic responses; capture each request body. */
function scriptFetch(responses: unknown[]): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  let i = 0
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}'))
    const body = responses[Math.min(i, responses.length - 1)]
    i++
    return new Response(JSON.stringify(body), { status: 200, statusText: 'OK' })
  }) as unknown as typeof fetch

  return { bodies }
}

const auth = {
  provider: 'anthropic' as const,
  key: 'sk-ant-test',
  model: 'claude-haiku-4-5-20251001'
}

describe('runAgent', () => {
  it('reads via a tool then answers, sending tools + cached system on the first call', async () => {
    const { bodies } = scriptFetch([
      {
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check your day.' },
          { type: 'tool_use', id: 'tu1', name: 'get_upcoming', input: { days: 7 } }
        ],
        usage: { input_tokens: 50, output_tokens: 10 }
      },
      {
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'You have nothing scheduled today.' }],
        usage: { input_tokens: 80, output_tokens: 12 }
      }
    ])

    const res = await runAgent(auth, "what's on today?", [], new AbortController().signal)

    expect(res.answer).toBe('You have nothing scheduled today.')
    expect(res.toolCalls).toEqual([{ name: 'get_upcoming', ok: true }])
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    // First request advertises the tools and marks the system prompt for caching.
    expect(Array.isArray(bodies[0].tools)).toBe(true)
    expect(
      (bodies[0].tools as Array<{ name: string }>).some((t) => t.name === 'get_upcoming')
    ).toBe(true)
    expect((bodies[0].system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({
      type: 'ephemeral'
    })
    // Second request echoes the tool_result back to the model.
    const secondMsgs = bodies[1].messages as Array<{
      role: string
      content: Array<{ type: string }>
    }>
    expect(secondMsgs.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(true)
  })

  it('routes propose_task through the inbox (pending row) and surfaces the proposalId', async () => {
    scriptFetch([
      {
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'propose_task',
            input: { title: 'Email Sam', listType: 'daily' }
          }
        ]
      },
      {
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: "I've queued that task for your approval." }]
      }
    ])

    const res = await runAgent(auth, 'remind me to email Sam', [], new AbortController().signal)

    expect(res.toolCalls).toEqual([{ name: 'propose_task', ok: true }])
    expect(res.proposalIds).toHaveLength(1)
    const rows = drizzle(sqlite, { schema }).select().from(schema.claudeProposals).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].source).toBe('ask-compass')
    // No checklist item was actually written.
    expect(drizzle(sqlite, { schema }).select().from(schema.checklistItems).all()).toHaveLength(0)
  })

  it('stops after MAX_AGENT_STEPS if the model never stops requesting tools', async () => {
    // Always return tool_use → the loop must bail with a fallback message.
    scriptFetch([
      {
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'loop', name: 'get_upcoming', input: {} }]
      }
    ])
    const res = await runAgent(auth, 'loop forever', [], new AbortController().signal)
    expect(res.answer).toMatch(/ran out of reasoning steps/i)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(6)
  })
})
