/**
 * Ollama local-AI helper — Compass Phase 4.
 *
 * All calls go to http://localhost:11434 (Ollama's default port).
 * This module NEVER calls external network endpoints — 100% local-first.
 *
 * ── Security / prompt-injection notes ────────────────────────────────────────
 * Raw email/GitHub bodies are never passed to the model verbatim.  The caller
 * (extractFactsViaOllama) is responsible for passing pre-sanitised snippets
 * (subject + From header, or issue title + repo name) rather than full bodies.
 * The output is validated against a strict JSON schema before being used; any
 * response that does not parse or does not match the schema is silently discarded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Default model — small enough to be pre-pulled on many machines. */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b'

/** Ollama API base (can be overridden for tests or custom installs). */
const BASE_URL = 'http://localhost:11434'

// ── Result cache ──────────────────────────────────────────────────────────────

interface DetectionResult {
  available: boolean
  baseUrl?: string
  models?: string[]
}

let _cachedResult: DetectionResult | null = null
let _cacheExpiry = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes per process

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ping the local Ollama instance and return available models.
 * Result is cached for 5 minutes so the cron path doesn't hammer the socket.
 */
export async function detectOllama(): Promise<DetectionResult> {
  const now = Date.now()
  if (_cachedResult && now < _cacheExpiry) {
    return _cachedResult
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5_000) // 5-second probe

    let resp: Response
    try {
      resp = await fetch(`${BASE_URL}/api/tags`, { signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!resp.ok) {
      _cachedResult = { available: false }
      _cacheExpiry = now + CACHE_TTL_MS
      return _cachedResult
    }

    const data = (await resp.json()) as { models?: Array<{ name: string }> }
    const models = (data.models ?? []).map((m) => m.name)

    _cachedResult = { available: true, baseUrl: BASE_URL, models }
    _cacheExpiry = now + CACHE_TTL_MS
    return _cachedResult
  } catch {
    // Connection refused, timeout, parse error — all mean Ollama is not running
    _cachedResult = { available: false }
    _cacheExpiry = now + CACHE_TTL_MS
    return _cachedResult
  }
}

/**
 * POST a single-turn prompt to Ollama (/api/generate, stream: false).
 * Returns the raw text response.  Throws on network error, timeout, or
 * non-200 status so the caller can handle it.
 *
 * @param model   - Model tag, e.g. "llama3.2:3b"
 * @param prompt  - The full prompt string
 * @param options - Optional Ollama model parameters
 */
export async function runOllamaPrompt(
  model: string,
  prompt: string,
  options: Record<string, unknown> = {}
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000) // 30-second timeout

  try {
    const resp = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: 4096,
          ...options
        }
      })
    })

    if (!resp.ok) {
      throw new Error(`Ollama returned HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { response?: string }
    if (typeof data.response !== 'string') {
      throw new Error('Ollama response missing "response" field')
    }
    return data.response
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Expose cache-bust for tests so each test starts with a clean slate. */
export function _resetOllamaCache(): void {
  _cachedResult = null
  _cacheExpiry = 0
}
