/**
 * Tests for the BYO-key LLM client. We mock global `fetch` so the
 * provider HTTP shape is exercised without leaving the machine.
 *
 * Focus: the rewritten 401 messages — they need to name the cause
 * (wrong endpoint for this key, e.g. third-party proxy key sent to
 * api.anthropic.com) and the fix in a single short sentence.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { callLlm } from './llm-client'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        statusText: status === 401 ? 'Unauthorized' : 'Error'
      })
  ) as unknown as typeof fetch
}

describe('callLlm — Anthropic 401', () => {
  it('rewrites 401 to a clean actionable one-liner', async () => {
    mockFetch(401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' }
    })
    await expect(
      callLlm({
        provider: 'anthropic',
        apiKey: 'sk-KDQk-proxy-key',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toThrow(/Anthropic rejected the API key.*sk-ant-.*third-party/i)
  })

  it("surfaces Anthropic's own error.message but never the api key", async () => {
    mockFetch(401, {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' }
    })
    try {
      await callLlm({
        provider: 'anthropic',
        apiKey: 'sk-KDQk-proxy-key',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }]
      })
    } catch (err) {
      const msg = (err as Error).message
      // Anthropic's diagnostic reason is included to help the user.
      expect(msg).toContain('invalid x-api-key')
      // But never the raw key or the response envelope.
      expect(msg).not.toContain('sk-KDQk')
      expect(msg).not.toContain('authentication_error')
    }
  })

  it('keeps the existing detailed error for non-401 responses', async () => {
    mockFetch(429, 'rate limited')
    await expect(
      callLlm({
        provider: 'anthropic',
        apiKey: 'sk-ant-real',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toThrow(/Anthropic 429/)
  })
})

describe('callLlm — OpenAI 401', () => {
  it('rewrites 401 to a clean actionable one-liner', async () => {
    mockFetch(401, { error: { message: 'invalid_api_key' } })
    await expect(
      callLlm({
        provider: 'openai',
        apiKey: 'sk-bad',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toThrow(/OpenAI rejected the API key.*platform\.openai\.com/i)
  })
})

describe('callLlm — Anthropic tool-use + prompt caching (8.5)', () => {
  it('sends tools + marks the system prompt for caching, and parses tool_use + stop_reason', async () => {
    let captured: Record<string, unknown> = {}
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}')
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'tu1', name: 'get_upcoming', input: { days: 3 } }
          ],
          usage: { input_tokens: 20, output_tokens: 5 }
        }),
        { status: 200, statusText: 'OK' }
      )
    }) as unknown as typeof fetch

    const res = await callLlm({
      provider: 'anthropic',
      apiKey: 'sk-ant-x',
      system: 'sys',
      messages: [{ role: 'user', content: 'plan my day' }],
      tools: [
        { name: 'get_upcoming', description: 'read agenda', input_schema: { type: 'object' } }
      ],
      cacheSystem: true
    })

    // Request shape.
    expect(Array.isArray(captured.tools)).toBe(true)
    expect((captured.system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({
      type: 'ephemeral'
    })
    // Response parsing.
    expect(res.stopReason).toBe('tool_use')
    expect(res.toolUses).toEqual([{ id: 'tu1', name: 'get_upcoming', input: { days: 3 } }])
    expect(res.text).toBe('checking')
  })

  it('passes structured content blocks (tool_result) through untouched', async () => {
    let captured: Record<string, unknown> = {}
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}')
      return new Response(
        JSON.stringify({
          model: 'm',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }]
        }),
        { status: 200, statusText: 'OK' }
      )
    }) as unknown as typeof fetch

    await callLlm({
      provider: 'anthropic',
      apiKey: 'sk-ant-x',
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{}' }] }
      ]
    })
    const msgs = captured.messages as Array<{ content: Array<{ type: string }> }>
    expect(msgs[0].content[0].type).toBe('tool_result')
  })
})
