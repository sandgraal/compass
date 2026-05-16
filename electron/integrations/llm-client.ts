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
  content: string
}

export interface LlmRequest {
  provider: LlmProvider
  apiKey: string
  model?: string
  system: string
  messages: LlmMessage[]
  maxTokens?: number
  /** AbortSignal so the renderer can cancel mid-request via `assistant:cancel`. */
  signal?: AbortSignal
}

export interface LlmResponse {
  text: string
  model: string
  inputTokens?: number
  outputTokens?: number
}

export class LlmAbortError extends Error {
  constructor() {
    super('Request aborted')
    this.name = 'LlmAbortError'
  }
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  // Anthropic — claude-3.5-haiku is the cheapest current Claude model
  // that handles citation-style answers well at low latency.
  anthropic: 'claude-3-5-haiku-latest',
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
  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: [{ type: 'text', text: m.content }]
    }))
  }
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
    // Strip any echoed auth headers from the error string defensively.
    throw new Error(
      `Anthropic ${resp.status} ${resp.statusText}: ${text.slice(0, 300).replace(/sk-[A-Za-z0-9_-]+/g, '<redacted>')}`
    )
  }
  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>
    model?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text =
    json.content
      ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('') ?? ''
  return {
    text,
    model: json.model ?? req.model,
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens
  }
}

async function callOpenAI(
  req: LlmRequest & { model: string; maxTokens: number }
): Promise<LlmResponse> {
  // OpenAI accepts the system message as the first item in `messages`.
  const oaiMessages = [
    { role: 'system', content: req.system },
    ...req.messages.map((m) => ({ role: m.role, content: m.content }))
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
