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
