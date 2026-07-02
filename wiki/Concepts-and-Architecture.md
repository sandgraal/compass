# Concepts & Architecture

This page explains the model behind Compass — enough to understand *why* it's private and *how*
the pieces fit. For the deep contributor reference, see [`docs/architecture.md`](https://github.com/sandgraal/compass/blob/main/docs/architecture.md).

## The core idea: local-first

Most people run their life across a dozen apps that each monetize their data. Compass collapses
that into **one offline desktop app where the data lives on your machine and stays there.** There
is no Compass server. The only network traffic is:

- OAuth tokens you grant, used to **pull your own data back** (Google, GitHub, Plaid).
- AI requests you explicitly trigger, and only if you've added a key — local **Ollama** is preferred.

The app opens on **Overview** (`/overview`), a unified home page assembled from everything Compass
already knows — money, tasks, calendar, and Timeline highlights — rather than any single domain
page. Money-related pages now include **Retirement** (a long-horizon, tax-aware projection) and
**CR Rental Studio** (short-term-rental pricing/P&L) alongside Finance. The sidebar groups all
pages into domain sections (Home, People & Places, Money, Planner, Knowledge, Your Data, System)
so navigation scales as more pages ship. None of this changes the security model below — it's the
same IPC boundary, just more surface area on top of it.

## The two-process security boundary

Compass is an Electron app split into a hardened renderer and a privileged main process.

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  Renderer (React, sandbox)  │         │  Main (Node, full access)   │
│  src/                       │  IPC    │  electron/                  │
│                             │ ──────► │  - DB (better-sqlite3)      │
│  - Pages, components        │         │  - Vault (safeStorage)      │
│  - Zustand store            │ ◄────── │  - OAuth (Google, GitHub)   │
│  - TipTap editor            │  events │  - Sync cron jobs           │
│  NO Node imports.           │         │  - Knowledge file watcher   │
│  Touches IPC only.          │         │  - File system              │
└─────────────────────────────┘         └─────────────────────────────┘
```

- **`contextIsolation: true`, `nodeIntegration: false`.** The renderer can never `require('fs')`
  or touch Node — it can only call typed functions exposed on `window.api` through the preload
  context bridge.
- **All sensitive operations live in the main process** (`electron/ipc/*`), validate their
  inputs, and are the *sole* writers to your data.
- **CSP** in production blocks remote scripts and `eval`, with an explicit allowlist for the
  OAuth/API endpoints you opt into.

Every feature is wired through this boundary with the same three-file pattern (handler →
preload → renderer type). See the [Developer Guide](Developer-Guide#adding-an-ipc-handler).

## Where your data lives

Everything is under your OS application-data directory (macOS: `~/Library/Application Support/Compass/`):

| Store | Path | Encrypted? | Used by |
|---|---|---|---|
| **SQLite DB** | `.data/compass.db` | No | tasks, accounts, transactions, calendar, habits, integration state |
| **Vault** | `.vault/<category>.enc` | **Yes** (AES-256-GCM) | secrets (financial, identity, credentials, medical, legal) |
| **Vault master key** | `.vault/key.enc` | sealed by **OS Keychain** (`safeStorage`) | decrypting the vault |
| **OAuth tokens** | `.vault/oauth-<service>.enc` | **Yes** | integrations |
| **Knowledge base** | `knowledge-base/<category>/*.md` | No (plain markdown) | your notes |
| **Embeddings index** | `.data/knowledge-embeddings.json` | No | semantic search |
| **Claude Inbox** | `.data/claude-inbox.jsonl` | No (no secrets) | proposed writes from Claude |

Because the knowledge base is **plain markdown on disk**, you own it completely — edit it in any
editor, back it up, grep it. Compass watches the folder (`chokidar`) and re-indexes on external edits.

See the full table layout in [Data & Storage Reference](Data-and-Storage-Reference).

## How a sync works

Each integration follows the same loop:

1. You click **Connect** → an OAuth window opens (or you paste a token).
2. Tokens are encrypted via `safeStorage` and written to `.vault/oauth-<service>.enc`.
3. A `node-cron` job schedules background syncs (per-integration interval, default 15 min).
4. On each tick: fetch the API → upsert rows into the DB → regenerate the relevant markdown in
   `knowledge-base/` → push a `sync:update` event to the renderer.
5. The UI cards refresh on that event.

## Background processes

- **Knowledge watcher** — `chokidar` on `knowledge-base/` re-indexes on external edits.
- **Sync scheduler** — `node-cron` runs per-integration syncs and a **nightly net-worth snapshot** at 00:05 local time.
- **Theme listener** — re-emits to the renderer on macOS dark/light flips.
- **Auto-updater** — `electron-updater` polls GitHub Releases.

## The Claude / MCP boundary

Compass ships a **separate, read-only** MCP process that opens the DB with `readonly: true` and
exposes a curated set of read tools to Claude — **the vault is categorically excluded and finance
is exposed as summaries, never raw rows.** Claude can *propose* writes, which land in an
append-only inbox and require **human approval** inside Compass before anything is written. See
[Claude & MCP](Claude-and-MCP).

## Tech stack

Electron 41 · React 18 + TypeScript · Drizzle ORM / SQLite (`better-sqlite3`) · TipTap editor ·
Recharts · Tailwind (indigo-on-navy, Inter + JetBrains Mono) · Vitest + Playwright · Biome ·
electron-vite / electron-builder.
