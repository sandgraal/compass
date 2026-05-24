/**
 * Provider-neutral LLM client for "Ask Compass" — Tier 2 #7.
 *
 * Two providers in v1: Anthropic and OpenAI. Both speak HTTP-only so
 * we don't pull in their SDKs (which would balloon the bundle and lock
 * us into version-specific behaviour). Each request is a one-shot
 * (non-streaming) completion that returns the raw text + token usage.
 *
 * The system prompt is owned by the IPC handler that calls us; this
 * file just maps `{ system, messages }` onto the two providers' wire
 * formats so the caller can stay provider-agnostic.
 *
 * Sensitive-data posture:
 *   - The API key is sent on every request via the provider's standard
 *     auth header. We do NOT log requests, responses, or the key.
 *   - Errors are normalized so the renderer sees a clean message and
 *     never sees the auth header / key.
 *   - Aborts are surfaced as `LlmAbortError` so the renderer can
 *     distinguish user-cancelled from genuine failures.
 */

import type { LlmProvider } from './assistant-vault'

export interface LlmMessage {
  role: 'user' | 'assistant'
  // A plain string (the common case) or Anthropic content blocks — the agent
  // loop (Phase 8.5) passes `tool_use` / `tool_result` blocks through here.
  content: string | AnthropicContentBlock[]
}

/** Anthropic tool definition (`input_schema` is JSON Schema). */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** A minimal Anthropic content block (text / tool_use / tool_result). */
export type AnthropicContentBlock = Record<string, unknown> & { type: string }

export interface LlmToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LlmRequest {
  provider: LlmProvider
  apiKey: string
  model?: string
  system: string
  messages: LlmMessage[]
  maxTokens?: number
  /** Anthropic tool-use (8.5). Ignored by the OpenAI path. */
  tools?: AnthropicTool[]
  /** Mark the system prompt with `cache_control` for prompt caching (Anthropic). */
  cacheSystem?: boolean
  /** AbortSignal so the renderer can cancel mid-request via `assistant:cancel`. */
  signal?: AbortSignal
}

export interface LlmResponse {
  text: string
  model: string
  inputTokens?: number
  outputTokens?: number
  /** Anthropic `stop_reason` (e.g. 'tool_use', 'end_turn') when available. */
  stopReason?: string
  /** Tool-use blocks the model emitted (Anthropic, when tools are supplied). */
  toolUses?: LlmToolUse[]
}

export class LlmAbortError extends Error {
  constructor() {
    super('Request aborted')
    this.name = 'LlmAbortError'
  }
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  // Anthropic — claude-haiku-4-5 is the cheapest current Claude model
  // that handles citation-style answers well at low latency. Pinned
  // (not -latest) so a silent Anthropic alias deprecation doesn't
  // surface as a 401/404 inside Ask Compass.
  anthropic: 'claude-haiku-4-5-20251001',
  // OpenAI — gpt-4o-mini is the equivalent cost/quality tier.
  openai: 'gpt-4o-mini'
}

const DEFAULT_MAX_TOKENS = 1024

export async function callLlm(req: LlmRequest): Promise<LlmResponse> {
  const model = req.model?.trim() || DEFAULT_MODELS[req.provider]
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS

  if (req.provider === 'anthropic') {
    return callAnthropic({ ...req, model, maxTokens })
  }
  return callOpenAI({ ...req, model, maxTokens })
}

async function callAnthropic(
  req: LlmRequest & { model: string; maxTokens: number }
): Promise<LlmResponse> {
  // System as a content-block array when caching, so we can attach
  // `cache_control` (Anthropic caches the stable prefix and bills repeat turns
  // at a fraction of the input-token cost).
  const system = req.cacheSystem
    ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
    : req.system
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system,
    messages: req.messages.map((m) => ({
      role: m.role,
      // Pass structured blocks (tool_use / tool_result) through untouched;
      // wrap a plain string as a single text block.
      content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    }))
  }
  if (req.tools && req.tools.length > 0) body.tools = req.tools
  let resp: Response
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: req.signal
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw new LlmAbortError()
    throw new Error(`Anthropic request failed: ${(err as Error).message}`)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    if (resp.status === 401) {
      // Extract Anthropic's own error.message when present — it's the
      // most useful signal for the legitimate-but-still-failing case
      // (revoked key, wrong workspace, no billing, etc.).
      let upstream = ''
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } }
        if (typeof parsed.error?.message === 'string') upstream = ` (${parsed.error.message})`
      } catch {
        /* not JSON, leave upstream empty */
      }
      throw new Error(
        `Anthropic rejected the API key${upstream}. Confirm the key is from console.anthropic.com (starts with "sk-ant-") and that the workspace has billing set up. Third-party Claude proxies (e.g. claudeapi.com) won't authenticate here.`
      )
    }
    // Strip any echoed auth headers from the error string defensively.
    throw new Error(
      `Anthropic ${resp.status} ${resp.statusText}: ${text.slice(0, 300).replace(/sk-[A-Za-z0-9_-]+/g, '<redacted>')}`
    )
  }
  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
    model?: string
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text =
    json.content
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('') ?? ''
  const toolUses: LlmToolUse[] = (json.content ?? [])
    .filter((c) => c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      input: (c.input ?? {}) as Record<string, unknown>
    }))
  return {
    text,
    model: json.model ?? req.model,
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens,
    stopReason: json.stop_reason,
    toolUses: toolUses.length > 0 ? toolUses : undefined
  }
}

async function callOpenAI(
  req: LlmRequest & { model: string; maxTokens: number }
): Promise<LlmResponse> {
  // OpenAI accepts the system message as the first item in `messages`. It only
  // supports plain-string turns — tool-use block arrays are Anthropic-only, so
  // reaching here with one is a programming error: fail loud rather than
  // silently dropping content and producing misleading output.
  const oaiMessages = [
    { role: 'system', content: req.system },
    ...req.messages.map((m) => {
      if (typeof m.content !== 'string') {
        throw new Error(
          'OpenAI path received non-string message content (tool-use blocks are Anthropic-only).'
        )
      }
      return { role: m.role, content: m.content }
    })
  ]
  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: oaiMessages
  }
  let resp: Response
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`
      },
      body: JSON.stringify(body),
      signal: req.signal
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw new LlmAbortError()
    throw new Error(`OpenAI request failed: ${(err as Error).message}`)
  }
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error(
        'OpenAI rejected the API key. Get a key from platform.openai.com — it should start with "sk-".'
      )
    }
    const text = await resp.text().catch(() => '')
    throw new Error(
      `OpenAI ${resp.status} ${resp.statusText}: ${text.slice(0, 300).replace(/sk-[A-Za-z0-9_-]+/g, '<redacted>')}`
    )
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    model?: string
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = json.choices?.[0]?.message?.content ?? ''
  return {
    text,
    model: json.model ?? req.model,
    inputTokens: json.usage?.prompt_tokens,
    outputTokens: json.usage?.completion_tokens
  }
}

// Exported for unit tests.
export const _internal = { DEFAULT_MODELS, callAnthropic, callOpenAI }
