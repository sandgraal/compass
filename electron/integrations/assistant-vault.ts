/**
 * Encrypted storage for LLM API keys (BYO-key model — Tier 2 #7 from
 * the May 2026 strategic review).
 *
 * Mirrors the on-disk shape the existing Plaid vault already uses:
 * a single `.vault/assistant.enc` AES-256-GCM blob, keyed by the same
 * `getOrCreateKey()` master key wrapped via `safeStorage`. The user's
 * API key never round-trips through the renderer — only the boolean
 * "do we have one configured" plus the masked tail.
 *
 * Why we hold it at all (vs. asking the user every time): the
 * "ask my data" loop runs ~10 prompts per session; re-prompting for a
 * 70-char API key each time is hostile. The vault posture means the
 * key lives at-rest only encrypted with the OS Keychain-protected
 * master, never plaintext on disk.
 *
 * `provider` is part of the stored record so users can toggle between
 * Anthropic and OpenAI without re-pasting. We store BOTH keys when
 * given (one per provider) so toggling is friction-free.
 */

import { getOrCreateKey, readEncryptedJson, writeEncryptedJson } from '../lib/crypto-vault'

export type LlmProvider = 'anthropic' | 'openai'

interface AssistantKeyBlob {
  // Map of provider → key. Missing entries are not configured.
  keys: Partial<Record<LlmProvider, string>>
  // The currently-active provider for `assistant:ask`.
  activeProvider?: LlmProvider
  // Per-provider preferred model. Optional — when absent the caller
  // falls back to a sensible default.
  models?: Partial<Record<LlmProvider, string>>
  // When the user last cleared all keys. Surfaces in the Settings UI
  // so they know an "Unset" actually landed.
  lastClearedAt?: number
}

// Mutators await the key ONCE, then load → modify → persist synchronously (no
// await in between), so concurrent callers can't drop each other's writes.
function load(key: Buffer): AssistantKeyBlob {
  const existing = readEncryptedJson<AssistantKeyBlob>('assistant', key)
  if (!existing) return { keys: {} }
  // Defensive: a corrupted/v0-shaped blob shouldn't crash the assistant.
  if (typeof existing !== 'object' || !existing.keys || typeof existing.keys !== 'object') {
    return { keys: {} }
  }
  return existing
}

function persist(blob: AssistantKeyBlob, key: Buffer): void {
  writeEncryptedJson('assistant', blob, key)
}

/** Mask a key for safe display (renderer-bound). e.g. `sk-…aB12`. */
function maskKey(raw: string): string {
  if (raw.length <= 8) return '••••'
  return `${raw.slice(0, 3)}…${raw.slice(-4)}`
}

export async function getAssistantStatus(): Promise<{
  configuredProviders: LlmProvider[]
  activeProvider: LlmProvider | null
  // map of provider → masked tail. NEVER the raw key.
  masks: Partial<Record<LlmProvider, string>>
  models: Partial<Record<LlmProvider, string>>
  lastClearedAt: number | null
}> {
  const blob = load(await getOrCreateKey())
  const configuredProviders = Object.entries(blob.keys)
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k]) => k as LlmProvider)
  const masks: Partial<Record<LlmProvider, string>> = {}
  for (const provider of configuredProviders) {
    masks[provider] = maskKey(blob.keys[provider] as string)
  }
  return {
    configuredProviders,
    activeProvider:
      blob.activeProvider && configuredProviders.includes(blob.activeProvider)
        ? blob.activeProvider
        : (configuredProviders[0] ?? null),
    masks,
    models: blob.models ?? {},
    lastClearedAt: blob.lastClearedAt ?? null
  }
}

export async function setAssistantKey(provider: LlmProvider, rawKey: string): Promise<void> {
  if (typeof rawKey !== 'string' || rawKey.trim().length < 16) {
    throw new Error('API key looks too short — refusing to persist')
  }
  const key = await getOrCreateKey()
  const blob = load(key)
  blob.keys = { ...blob.keys, [provider]: rawKey.trim() }
  // First key set → make it the active provider so the user doesn't
  // have to do a second step to use it.
  if (!blob.activeProvider) blob.activeProvider = provider
  persist(blob, key)
}

export async function clearAssistantKey(provider: LlmProvider): Promise<void> {
  const key = await getOrCreateKey()
  const blob = load(key)
  if (!blob.keys[provider]) return
  delete blob.keys[provider]
  if (blob.activeProvider === provider) {
    const remaining = Object.keys(blob.keys) as LlmProvider[]
    blob.activeProvider = remaining[0]
  }
  blob.lastClearedAt = Date.now()
  persist(blob, key)
}

export async function clearAllAssistantKeys(): Promise<void> {
  const key = await getOrCreateKey()
  const blob: AssistantKeyBlob = {
    keys: {},
    activeProvider: undefined,
    models: load(key).models,
    lastClearedAt: Date.now()
  }
  persist(blob, key)
}

export async function setActiveProvider(provider: LlmProvider): Promise<void> {
  const key = await getOrCreateKey()
  const blob = load(key)
  if (!blob.keys[provider]) {
    throw new Error(`Cannot activate ${provider} — no key configured`)
  }
  blob.activeProvider = provider
  persist(blob, key)
}

export async function setProviderModel(provider: LlmProvider, model: string): Promise<void> {
  const trimmed = model.trim()
  const key = await getOrCreateKey()
  const blob = load(key)
  if (trimmed.length === 0) {
    // Strip the entry rather than persisting an empty string — empty
    // strings would beat the `??` default fallback in the renderer
    // and surface as a blank model field. Use destructure + shallow
    // copy (avoiding `delete`) so we don't trigger lint/perf/noDelete.
    if (blob.models) {
      const { [provider]: _removed, ...rest } = blob.models
      blob.models = Object.keys(rest).length === 0 ? undefined : rest
    }
  } else {
    blob.models = { ...(blob.models ?? {}), [provider]: trimmed }
  }
  persist(blob, key)
}

type KeyRecord = { provider: LlmProvider; key: string; model: string | undefined }

function pickFromBlob(blob: AssistantKeyBlob, provider: LlmProvider): KeyRecord | null {
  const key = blob.keys[provider]
  if (!key) return null
  return { provider, key, model: blob.models?.[provider] }
}

/**
 * Internal-only — never crosses an IPC boundary unmasked. Reads the
 * stored key for any specific provider, regardless of which one is
 * currently active. Used by the `assistant:test-key` handler so the
 * user can validate a provider they haven't switched to yet.
 */
export async function readKeyInternal(provider: LlmProvider): Promise<KeyRecord | null> {
  return pickFromBlob(load(await getOrCreateKey()), provider)
}

/**
 * Internal-only — never crosses an IPC boundary unmasked. Used by the
 * `assistant:ask` handler to make the actual LLM call. Loads the vault
 * exactly once per call.
 */
export async function readActiveKeyInternal(): Promise<KeyRecord | null> {
  const blob = load(await getOrCreateKey())
  const provider = blob.activeProvider
  if (!provider) return null
  return pickFromBlob(blob, provider)
}

// Exported for unit tests.
export const _internal = { maskKey }
