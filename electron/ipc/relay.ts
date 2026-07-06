/**
 * Relay IPC (Phase — integrations redesign). Lets the renderer read + override
 * the aggregator relay URL and run a connectivity test, so a self-hoster can
 * point Compass at their own relay (per relay/README) instead of the
 * not-currently-deployed managed default. Main-process fetch (CSP-free), like
 * relayFetch — no renderer CSP widening.
 */

import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { appSettings } from '../db/schema'
import { DEFAULT_RELAY_URL } from '../integrations/relay-client'
import { loadToken } from './auth'

/** Which BYO-capable aggregators have stored their own upstream credentials. */
const BYO_CAPABLE = ['terra', 'snaptrade'] as const

export interface RelayValidation {
  ok: boolean
  /** Normalized URL (trailing slashes stripped) when ok. */
  url?: string
  error?: string
}

/** Pure: validate + normalize a user-entered relay URL. Exported for tests. */
export function validateRelayUrl(raw: string): RelayValidation {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Enter a relay URL (or clear it to use the default).' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Enter a valid URL, e.g. https://relay.example.com' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Relay URL must use http:// or https://' }
  }
  return { ok: true, url: trimmed.replace(/\/+$/, '') }
}

/** Pure: pick the effective relay URL + whether it's the built-in default. */
export function pickRelayUrl(custom: string | null | undefined): {
  relayUrl: string
  isDefault: boolean
} {
  const c = custom?.trim()
  return c ? { relayUrl: c, isDefault: false } : { relayUrl: DEFAULT_RELAY_URL, isDefault: true }
}

function readRelayUrlSetting(): string | null {
  const db = getDb()
  const row = db.select().from(appSettings).where(eq(appSettings.key, 'relayUrl')).get()
  return row?.value ?? null
}

function detectByoAggregators(): string[] {
  const out: string[] = []
  for (const id of BYO_CAPABLE) {
    const tok = loadToken(id) as Record<string, unknown> | null
    if (!tok) continue
    if (id === 'terra') {
      const devId = typeof tok.devId === 'string' ? tok.devId.trim() : ''
      const apiKey = typeof tok.apiKey === 'string' ? tok.apiKey.trim() : ''
      if (devId && apiKey) out.push(id)
    } else if (id === 'snaptrade') {
      const clientId = typeof tok.clientId === 'string' ? tok.clientId.trim() : ''
      const consumerKey = typeof tok.consumerKey === 'string' ? tok.consumerKey.trim() : ''
      if (clientId && consumerKey) out.push(id)
    }
  }
  return out
}

export function registerRelayHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('relay:get-config', () => {
    const { relayUrl, isDefault } = pickRelayUrl(readRelayUrlSetting())
    return {
      relayUrl,
      isDefault,
      defaultUrl: DEFAULT_RELAY_URL,
      byoAggregators: detectByoAggregators()
    }
  })

  // Set (or clear, when passed an empty string / null) the relay URL override.
  ipcMain.handle('relay:set-url', (_event, url: unknown) => {
    const raw = typeof url === 'string' ? url.trim() : ''
    const db = getDb()
    if (!raw) {
      db.delete(appSettings).where(eq(appSettings.key, 'relayUrl')).run()
      return { success: true, relayUrl: DEFAULT_RELAY_URL, isDefault: true }
    }
    const v = validateRelayUrl(raw)
    if (!v.ok || !v.url) return { success: false, error: v.error ?? 'Invalid relay URL.' }
    db.insert(appSettings)
      .values({ key: 'relayUrl', value: v.url, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: v.url, updatedAt: new Date() }
      })
      .run()
    return { success: true, relayUrl: v.url, isDefault: false }
  })

  // Connectivity probe against <relayUrl>/healthz. Optionally test a
  // not-yet-saved URL passed from the settings form.
  ipcMain.handle('relay:test', async (_event, url: unknown) => {
    const candidate = typeof url === 'string' && url.trim() ? url.trim() : readRelayUrlSetting()
    const { relayUrl } = pickRelayUrl(candidate)
    const base = relayUrl.replace(/\/+$/, '')
    const started = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${base}/healthz`, { signal: controller.signal })
      clearTimeout(timer)
      return { ok: res.ok, status: res.status, latencyMs: Date.now() - started, relayUrl: base }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
        relayUrl: base
      }
    }
  })
}
