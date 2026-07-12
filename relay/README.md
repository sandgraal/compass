# Compass Relay (Phase 10.9)

A **stateless, metered relay** that fronts paid data-aggregator APIs so Compass users don't
each need their own (approval-gated, paid) developer account. It is the "we pay for it, but
don't get abused" layer of the [Storehouse aggregator strategy](../docs/storehouse-roadmap.md)
(§3.G / §4f).

**First aggregator: [Terra](https://tryterra.co)** (500+ wearables → the Compass Health hub).

## What it does — and deliberately doesn't

- **Holds the paid keys server-side.** The Terra `dev-id` / `x-api-key` live only here (env),
  never in a client. That is the whole reason the relay exists.
- **Meters every user.** Per-user daily call + byte caps, a monthly cost ceiling, an
  anomaly (burst) breaker, and a connected-account cap — all in [`metering.ts`](src/metering.ts).
  When a hard cap is hit the client is told to connect its own key (the BYO escape hatch).
- **Deny-by-default proxy.** Only the endpoints an adapter allowlists are forwarded
  ([`adapters/terra.ts`](src/adapters/terra.ts)); everything else is refused.
- **Stores NO user data.** It records counters only (calls/bytes/cost) and passes the upstream
  response straight back. It is a meter, not a data custodian — the data still lands on the
  user's disk, in Compass.

## Run locally

```bash
cd relay
npm install        # only dev dep is tsx; runtime is zero-dependency (Node http + global fetch)
TERRA_DEV_ID=… TERRA_API_KEY=… RELAY_CLIENT_TOKENS=my-device-token npm start
# → [relay] listening on :8787
curl localhost:8787/healthz            # {"ok":true}
```

Requires Node ≥ 18 (global `fetch`).

## Environment

| Var | Required | Purpose |
|---|---|---|
| `TERRA_DEV_ID`, `TERRA_API_KEY` | yes (for Terra) | the paid Terra developer credentials, injected on every upstream call |
| `RELAY_CLIENT_TOKENS` | recommended | comma-separated bearer tokens allowed to use the relay; **each token = one metered user**. Empty = accept any non-empty token (dev only) |
| `PORT` | no (8787) | listen port |
| `RELAY_CALLS_PER_DAY` | no (500) | per-user daily call cap |
| `RELAY_BYTES_PER_DAY` | no (52428800) | per-user daily upstream-byte cap |
| `RELAY_MONTHLY_COST` | no (1000) | per-user monthly cost-unit ceiling |
| `RELAY_BURST_PER_MIN` | no (60) | anomaly breaker: max calls in a rolling 60s |
| `RELAY_MAX_ACCOUNTS` | no (10) | max connected aggregator accounts per user |
| `RELAY_SYNC_DIR` | no (off) | **device sync (Phase 4b):** directory for the encrypted snapshot mailbox. Unset = `/sync/*` disabled. The one deliberate exception to "stores no user data" — and a narrow one: blobs are passphrase-encrypted on-device (AES-256-GCM); the relay can read none of it |
| `RELAY_SYNC_MAX_BYTES` | no (268435456) | max DECODED snapshot size accepted on a sync PUT |

## Client contract

`GET|POST /<aggregator>/<upstreamPath><?query>` with `Authorization: Bearer <client-token>`.
The relay forwards to `<adapter.upstreamBase><upstreamPath><?query>` with the secret auth
headers injected. Examples (Terra):

- `POST /terra/auth/generateWidgetSession` — start a connect session (counts as an account)
- `GET  /terra/daily?user_id=…&start_date=…&end_date=…` — pull normalized daily metrics

Device sync (only when `RELAY_SYNC_DIR` is set; same bearer auth — see [`src/sync.ts`](src/sync.ts)):

- `PUT /sync/blob/<groupId>` — upload an encrypted snapshot (`{blob, exportedAt, deviceId}` envelope, blob base64)
- `GET /sync/blob/<groupId>` — download it (`{blob, meta}`)
- `GET /sync/meta/<groupId>` — metadata only (the cheap "is remote newer?" check)

Sync auth caveat: **any allowlisted token can read/write any groupId** — passphrase pairing
requires different device tokens to reach the same group, so there's no token↔group binding.
Reads yield only ciphertext; the write side means allowlisted devices can overwrite each
other's snapshots (an availability, not confidentiality, concern — keep `RELAY_CLIENT_TOKENS`
scoped to devices you trust, and note the store keeps one `.prev` generation).

The Compass client is [`electron/integrations/relay-client.ts`](../electron/integrations/relay-client.ts),
which also implements the **BYO-direct** bypass (a user's own key → call the upstream directly,
skipping the relay).

## Deploy

Two shapes, same handler:

1. **Node service** — `tsx src/index.ts` behind TLS (Fly.io / Render / a container). Simplest.
2. **Serverless** — lift [`handleRelayRequest`](src/server.ts) into a Vercel/Cloudflare handler.

The default [`InMemoryMeteringStore`](src/metering.ts) only meters within one instance. For
multiple instances / serverless, implement `MeteringStore` over a shared KV (Upstash Redis,
Cloudflare KV) — it is a two-method interface (`get` / `set`).

## Tests

`npx vitest run relay/` — the metering engine (every abuse vector), the Terra allowlist, and
the full request pipeline against a mock upstream. Not wired into the app's `tsc` typecheck
(same as `mcp/`); validated by tests + Biome.
