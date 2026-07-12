/**
 * Relay entrypoint (Phase 10.9) — a tiny Node http server around
 * `handleRelayRequest`. Stateless + zero-dependency (Node built-in http + global
 * fetch). Deploy as a long-running Node service, or lift `handleRelayRequest` into
 * a serverless handler. Secrets + quotas come from env — see README.
 *
 * Run: `PORT=8787 TERRA_DEV_ID=… TERRA_API_KEY=… tsx src/index.ts`
 */

import { createServer } from 'node:http'
import { DEFAULT_QUOTA, InMemoryMeteringStore, type Quota } from './metering.js'
import { type RelayConfig, handleRelayRequest } from './server.js'
import { FsSyncStore } from './sync.js'

// The only bodies we forward are tiny JSON (e.g. the Terra widget-session POST).
// Cap the read so an internet-facing relay can't be memory/CPU-DoS'd by a large body.
const MAX_BODY_BYTES = 64 * 1024

// Device-sync snapshot PUTs are the one legitimately large body. Cap the DECODED
// blob via RELAY_SYNC_MAX_BYTES (default 256 MB); the base64 JSON envelope on the
// wire is ~4/3 of that plus envelope slack.
const SYNC_MAX_BLOB_BYTES = (() => {
  const v = Number(process.env.RELAY_SYNC_MAX_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 256 * 1024 * 1024
})()
const SYNC_MAX_BODY_BYTES = Math.ceil(SYNC_MAX_BLOB_BYTES * (4 / 3)) + 64 * 1024

function quotaFromEnv(): Quota {
  const n = (key: string, fallback: number): number => {
    const v = Number(process.env[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    callsPerDay: n('RELAY_CALLS_PER_DAY', DEFAULT_QUOTA.callsPerDay),
    bytesPerDay: n('RELAY_BYTES_PER_DAY', DEFAULT_QUOTA.bytesPerDay),
    monthlyCostCeiling: n('RELAY_MONTHLY_COST', DEFAULT_QUOTA.monthlyCostCeiling),
    burstPerMinute: n('RELAY_BURST_PER_MIN', DEFAULT_QUOTA.burstPerMinute),
    maxAccounts: n('RELAY_MAX_ACCOUNTS', DEFAULT_QUOTA.maxAccounts)
  }
}

const cfg: RelayConfig = {
  env: process.env,
  store: new InMemoryMeteringStore(), // single-instance; swap for a KV store to scale (see README)
  quota: quotaFromEnv(),
  clientTokens: new Set(
    (process.env.RELAY_CLIENT_TOKENS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  // Device sync (Phase 4b) — opt-in ciphertext mailbox, inert unless the
  // operator points it at a storage directory.
  sync: process.env.RELAY_SYNC_DIR
    ? { store: new FsSyncStore(process.env.RELAY_SYNC_DIR), maxBlobBytes: SYNC_MAX_BLOB_BYTES }
    : undefined
}

const server = createServer(async (req, res) => {
  try {
    // Sync snapshot PUTs are the one deliberately large body; everything else
    // keeps the tight anti-DoS cap.
    const isSyncPath = cfg.sync != null && (req.url ?? '').startsWith('/sync/')
    const maxBody = isSyncPath ? SYNC_MAX_BODY_BYTES : MAX_BODY_BYTES
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > maxBody) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
        req.destroy()
        return
      }
      chunks.push(c as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = new URL(req.url ?? '/', 'http://localhost')
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v
    }
    const out = await handleRelayRequest(
      {
        method: req.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.search,
        headers,
        body: raw.length > 0 ? raw : null
      },
      cfg
    )
    res.writeHead(out.status, out.headers)
    res.end(out.body)
  } catch (err) {
    // Log server-side only — never expose internal error detail (stack traces) to the caller.
    console.error('[relay] request error', err)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Relay error' }))
  }
})

const port = Number(process.env.PORT) || 8787
server.listen(port, () => {
  // stderr so it never contaminates a piped stdout
  console.error(`[relay] listening on :${port}`)
})
