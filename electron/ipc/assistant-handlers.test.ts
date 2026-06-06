/**
 * Tests for the assistant IPC config/control handlers in
 * `electron/ipc/assistant.ts` (Phase 0.7 coverage backfill).
 *
 * The existing suites cover the pure helpers (`buildContextBlock`,
 * `gatherContext`, `SYSTEM_PROMPT`) and `runAgent`. This file covers the
 * thin-but-branchy handlers that wrap the assistant-vault config + the
 * provider key test:
 *
 *   - assistant:get-status          → passes through getAssistantStatus()
 *   - assistant:set-key             → provider + key-type guards, store, error
 *   - assistant:clear-key           → per-provider vs clear-all fallback
 *   - assistant:set-active-provider → provider guard, set, error
 *   - assistant:set-model           → provider + model-type guards, set
 *   - assistant:test-key            → unknown provider, no-key, success,
 *                                      abort/timeout, generic error
 *   - assistant:cancel              → no-in-flight branch
 *
 * The LLM `ask` / `agent` streaming handlers are out of scope here — they
 * need the full provider + tool-loop and are exercised via runAgent's suite.
 *
 * Strategy: mock only the assistant-vault config module + the llm-client so
 * the handler branches are drivable; everything else loads for real.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { vault, callLlmMock, LlmAbortErrorMock } = vi.hoisted(() => {
  class LlmAbortErrorMock extends Error {}
  return {
    vault: {
      getAssistantStatus: vi.fn(),
      setAssistantKey: vi.fn(),
      clearAssistantKey: vi.fn(),
      clearAllAssistantKeys: vi.fn(),
      setActiveProvider: vi.fn(),
      setProviderModel: vi.fn(),
      readKeyInternal: vi.fn(),
      readActiveKeyInternal: vi.fn()
    },
    callLlmMock: vi.fn(),
    LlmAbortErrorMock
  }
})

vi.mock('../integrations/assistant-vault', () => vault)
vi.mock('../integrations/llm-client', () => ({
  callLlm: (...args: unknown[]) => callLlmMock(...args),
  LlmAbortError: LlmAbortErrorMock
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}
function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./assistant')
  mod.registerAssistantHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── assistant:get-status ─────────────────────────────────────────────────────

describe('assistant:get-status', () => {
  it('passes through getAssistantStatus()', async () => {
    const status = { activeProvider: 'anthropic', anthropic: { configured: true } }
    vault.getAssistantStatus.mockReturnValue(status)
    const h = await registerAndGet('assistant:get-status')
    expect(await invoke(h)).toBe(status)
  })
})

// ── assistant:set-key ────────────────────────────────────────────────────────

describe('assistant:set-key', () => {
  it('rejects an unknown provider', async () => {
    const h = await registerAndGet('assistant:set-key')
    expect(await invoke(h, 'gemini', 'sk-x')).toEqual({
      success: false,
      error: 'Unknown provider: gemini'
    })
    expect(vault.setAssistantKey).not.toHaveBeenCalled()
  })

  it('rejects a non-string key', async () => {
    const h = await registerAndGet('assistant:set-key')
    expect(await invoke(h, 'anthropic', 123)).toEqual({
      success: false,
      error: 'Key must be a string'
    })
  })

  it('stores a valid key', async () => {
    const h = await registerAndGet('assistant:set-key')
    expect(await invoke(h, 'anthropic', 'sk-ant-123')).toEqual({ success: true })
    expect(vault.setAssistantKey).toHaveBeenCalledWith('anthropic', 'sk-ant-123')
  })

  it('surfaces a store error', async () => {
    vault.setAssistantKey.mockImplementation(() => {
      throw new Error('keychain locked')
    })
    const h = await registerAndGet('assistant:set-key')
    expect(await invoke(h, 'openai', 'sk-oai')).toEqual({
      success: false,
      error: 'keychain locked'
    })
  })
})

// ── assistant:clear-key ──────────────────────────────────────────────────────

describe('assistant:clear-key', () => {
  it('clears a specific provider when named', async () => {
    const h = await registerAndGet('assistant:clear-key')
    expect(await invoke(h, 'anthropic')).toEqual({ success: true })
    expect(vault.clearAssistantKey).toHaveBeenCalledWith('anthropic')
    expect(vault.clearAllAssistantKeys).not.toHaveBeenCalled()
  })

  it('clears ALL keys when the provider is unrecognized/omitted', async () => {
    const h = await registerAndGet('assistant:clear-key')
    expect(await invoke(h, undefined)).toEqual({ success: true })
    expect(vault.clearAllAssistantKeys).toHaveBeenCalledOnce()
    expect(vault.clearAssistantKey).not.toHaveBeenCalled()
  })

  it('surfaces a clear error', async () => {
    vault.clearAssistantKey.mockImplementation(() => {
      throw new Error('disk error')
    })
    const h = await registerAndGet('assistant:clear-key')
    expect(await invoke(h, 'openai')).toEqual({ success: false, error: 'disk error' })
  })
})

// ── assistant:set-active-provider ────────────────────────────────────────────

describe('assistant:set-active-provider', () => {
  it('rejects an unknown provider', async () => {
    const h = await registerAndGet('assistant:set-active-provider')
    expect(await invoke(h, 'mistral')).toEqual({
      success: false,
      error: 'Unknown provider: mistral'
    })
  })

  it('sets a valid provider', async () => {
    const h = await registerAndGet('assistant:set-active-provider')
    expect(await invoke(h, 'openai')).toEqual({ success: true })
    expect(vault.setActiveProvider).toHaveBeenCalledWith('openai')
  })
})

// ── assistant:set-model ──────────────────────────────────────────────────────

describe('assistant:set-model', () => {
  it('rejects an unknown provider', async () => {
    const h = await registerAndGet('assistant:set-model')
    expect(await invoke(h, 'gemini', 'x')).toEqual({
      success: false,
      error: 'Unknown provider: gemini'
    })
  })

  it('rejects a non-string model', async () => {
    const h = await registerAndGet('assistant:set-model')
    expect(await invoke(h, 'anthropic', 42)).toEqual({
      success: false,
      error: 'Model must be a string'
    })
  })

  it('sets a valid model', async () => {
    const h = await registerAndGet('assistant:set-model')
    expect(await invoke(h, 'anthropic', 'claude-x')).toEqual({ success: true })
    expect(vault.setProviderModel).toHaveBeenCalledWith('anthropic', 'claude-x')
  })
})

// ── assistant:test-key ───────────────────────────────────────────────────────

describe('assistant:test-key', () => {
  it('rejects an unknown provider', async () => {
    const h = await registerAndGet('assistant:test-key')
    expect(await invoke(h, 'gemini')).toEqual({
      success: false,
      error: 'Unknown provider: gemini'
    })
  })

  it('reports when no key is configured', async () => {
    vault.readKeyInternal.mockReturnValue(null)
    const h = await registerAndGet('assistant:test-key')
    expect(await invoke(h, 'anthropic')).toEqual({
      success: false,
      error: 'No anthropic key configured.'
    })
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it('returns success when the provider round-trips a ping', async () => {
    vault.readKeyInternal.mockReturnValue({
      provider: 'anthropic',
      key: 'sk-ant',
      model: 'claude-x'
    })
    callLlmMock.mockResolvedValue({ text: 'ok' })
    const h = await registerAndGet('assistant:test-key')
    expect(await invoke(h, 'anthropic')).toEqual({ success: true })
    expect(callLlmMock).toHaveBeenCalledOnce()
  })

  it('maps an abort to a friendly timeout message', async () => {
    vault.readKeyInternal.mockReturnValue({ provider: 'openai', key: 'sk', model: 'gpt' })
    callLlmMock.mockRejectedValue(new LlmAbortErrorMock())
    const h = await registerAndGet('assistant:test-key')
    const res = (await invoke(h, 'openai')) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/timed out/i)
  })

  it('surfaces a generic provider error', async () => {
    vault.readKeyInternal.mockReturnValue({ provider: 'openai', key: 'sk', model: 'gpt' })
    callLlmMock.mockRejectedValue(new Error('401 Unauthorized'))
    const h = await registerAndGet('assistant:test-key')
    expect(await invoke(h, 'openai')).toEqual({ success: false, error: '401 Unauthorized' })
  })
})

// ── assistant:cancel ─────────────────────────────────────────────────────────

describe('assistant:cancel', () => {
  it('reports no in-flight request when nothing is running', async () => {
    const h = await registerAndGet('assistant:cancel')
    expect(await invoke(h)).toEqual({ success: false, error: 'No in-flight request' })
  })
})

// ── assistant:ask — request guards (no LLM call reached) ─────────────────────

describe('assistant:ask guards', () => {
  it('rejects a non-object payload', async () => {
    const h = await registerAndGet('assistant:ask')
    expect(await invoke(h, 'nope')).toEqual({ success: false, error: 'Invalid request payload' })
  })

  it('rejects a missing/empty question', async () => {
    const h = await registerAndGet('assistant:ask')
    expect(await invoke(h, { question: '   ' })).toEqual({
      success: false,
      error: 'Question is required'
    })
  })

  it('rejects an over-long question', async () => {
    const h = await registerAndGet('assistant:ask')
    const res = (await invoke(h, { question: 'x'.repeat(100_000) })) as {
      success: boolean
      error: string
    }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/too long/i)
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it('reports when no active key is configured', async () => {
    vault.readActiveKeyInternal.mockReturnValue(null)
    const h = await registerAndGet('assistant:ask')
    const res = (await invoke(h, { question: 'hello' })) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No LLM API key configured/i)
    expect(callLlmMock).not.toHaveBeenCalled()
  })
})

// ── assistant:agent — request guards (no agent loop reached) ──────────────────

describe('assistant:agent guards', () => {
  it('rejects a non-object payload', async () => {
    const h = await registerAndGet('assistant:agent')
    expect(await invoke(h, 5)).toEqual({ success: false, error: 'Invalid request payload' })
  })

  it('rejects a missing question', async () => {
    const h = await registerAndGet('assistant:agent')
    expect(await invoke(h, {})).toEqual({ success: false, error: 'Question is required' })
  })

  it('reports when no active key is configured', async () => {
    vault.readActiveKeyInternal.mockReturnValue(null)
    const h = await registerAndGet('assistant:agent')
    const res = (await invoke(h, { question: 'hi' })) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No LLM API key configured/i)
  })

  it('refuses a non-Anthropic active provider (agentic is Claude-only)', async () => {
    vault.readActiveKeyInternal.mockReturnValue({ provider: 'openai', key: 'sk', model: 'gpt' })
    const h = await registerAndGet('assistant:agent')
    const res = (await invoke(h, { question: 'hi' })) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/switch the active provider to Anthropic/i)
  })
})
