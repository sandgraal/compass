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
  )
}

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
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
