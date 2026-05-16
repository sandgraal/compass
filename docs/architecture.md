# Compass — Architecture

## Process boundary (Electron security model)

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  Renderer (React, sandbox)  │         │  Main (Node, full access)   │
│  src/                       │  IPC    │  electron/                  │
│                             │ ──────► │                             │
│  - Pages, components        │         │  - DB (better-sqlite3)      │
│  - Zustand store            │ ◄────── │  - Vault (safeStorage)      │
│  - TipTap editor            │  events │  - OAuth (Google, GitHub)   │
│                             │         │  - Sync cron jobs           │
│  NO Node imports.           │         │  - Knowledge file watcher   │
│  Touches IPC only.          │         │  - File system              │
└─────────────────────────────┘         └─────────────────────────────┘
              ▲                                       ▲
              │ contextBridge                         │ IPC handlers
              │ (preload.ts)                          │ (ipc/*.ts)
              └───────────────────────────────────────┘
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (Node access disabled but preload runs in a separate context).
CSP enforced in production builds (no eval, no remote scripts, allowlist for OAuth + APIs).

## Where things live

| Concern | Path |
|---|---|
| App entry, BrowserWindow, security flags | `electron/main.ts` |
| Context bridge (ALL IPC exposure) | `electron/preload.ts` |
| Renderer types for `window.api` | `src/types/electron.d.ts` |
| Cron jobs (sync scheduler) | `electron/cron.ts` |
| Drizzle schema | `electron/db/schema.ts` |
| DB singleton | `electron/db/client.ts` |
| Local data paths | `electron/paths.ts` |
| Vault encryption | `electron/ipc/vault.ts` |
| OAuth flows + token storage | `electron/ipc/auth.ts` |
| Sync logic per service | `electron/ipc/sync.ts` |
| Knowledge file write/read | `electron/knowledge/writer.ts` |
| Knowledge auto-update pipeline | `electron/knowledge/extractor.ts` |
| **App auto-updater** (electron-updater) | `electron/ipc/updater.ts` |
| Finance ingestion + budget | `electron/ipc/finance.ts`, `electron/integrations/finance.ts` |
| Finance — geo + CR purpose tagger | `electron/integrations/finance-geo.ts` |
| Finance — Schedule C / capex tax tagger | `electron/integrations/finance-tax.ts` |
| Finance — net-worth snapshots + inference | `electron/integrations/finance-snapshot.ts` |
| Finance — 90-day cash-flow forecast | `electron/integrations/finance-forecast.ts` |
| Finance — subscription audit (active/zombie/expired) | `electron/integrations/finance-subscriptions.ts` |
| DB migration runner (CLI: `npm run db:migrate`) | `electron/db/migrate.ts`, `electron/db/reconcile.ts` |
| Knowledge — regex / Ollama suggestion pipeline | `electron/knowledge/suggestions.ts`, `electron/knowledge/ollama.ts` |
| Tray + global shortcut + quick-capture window | `electron/menu-bar.ts`, `src/quickCapture/` |

## Database (Drizzle / SQLite via `better-sqlite3`)

20 tables. Lives at `~/Library/Application Support/Compass/.data/compass.db`.

| Table | Purpose |
|---|---|
| `integrations` | One row per service (google, github). Status, scopes, last sync, **per-integration `syncIntervalMinutes`**. |
| `sync_events` | Append-only log of every sync attempt (records updated, errors). |
| `checklist_items` | Daily/weekly/monthly tasks. Source = manual / github / calendar / gmail. |
| `checklist_templates` | User-edited markdown templates per list type. |
| `calendar_events` | Cached calendar events from any source. |
| `github_items` | Issues + PRs + project items. |
| `gmail_actions` | Action items extracted from Gmail. |
| `drive_files` | Google Drive file index. |
| `knowledge_files` | Index of `knowledge-base/*.md` files (path, title, word count). |
| `knowledge_suggestions` | Pending edits proposed by the regex / Ollama suggestion pipeline (Phase 2.7). |
| `app_settings` | Key/value (`syncInterval`, `theme`, weekly goals JSON, `quickCaptureShortcut`, etc.). |
| `finance_accounts` | Bank, credit, investment, debt accounts. Phase 4 added columns: `assetClass` (Phase 4.4 net-worth bucket), `paymentDayOfMonth` (Phase 4.5 forecast), `plaidItemId` + `plaidAccountId` + `mask` (Phase 4.6 Plaid linkage; indexed via `idx_finance_accounts_plaid`), `institution`, `paymentDueDate`. |
| `plaid_items` | One row per connected Plaid Item (institution). Cursor for `/transactions/sync` pagination, last sync timestamp, error code surface. Access tokens live in `.vault/plaid.enc` — NEVER here. (Phase 4.6) |
| `finance_transactions` | Hashed for dedup. Phase 4.2 promoted `geo` + `purpose` from `notes` tokens to **indexed** columns (`idx_..._geo`, `idx_..._geo_purpose`, `idx_..._geo_date`); Phase 4.3 added the **indexed** `(taxYear, taxTag)` pair for year-end aggregation. |
| `finance_balance_snapshots` | Per-(account, day) balance for net-worth trajectory + delta queries. Source = `manual` / `inferred` / `plaid`. (Phase 4.4) |
| `forecast_overrides` | User skip / shift / override edits to the auto-projected cash-flow stream. UNIQUE on `(account_id, date, label)`. (Phase 4.5) |
| `budget_rules` | Per-category monthly budget targets. |
| `categorization_rules` | Pattern → category rules for auto-categorization. |
| `habits` | User-defined habits with icon + color. |
| `habit_entries` | Per-habit-per-day completion (boolean). |

## Vault (encrypted, NOT in SQLite)

Per-category JSON blob in `~/Library/Application Support/Compass/.vault/<category>.enc`:
- AES-256-GCM, random 16-byte IV prepended, 16-byte authTag after IV
- Master key generated once, encrypted via `safeStorage` (OS Keychain), saved at `.vault/key.enc`
- Categories: `financial`, `identity`, `credentials`, `medical`, `legal`
- Each entry has `id`, `createdAt`, `updatedAt`, plus category-specific fields
- `_history` array (max 5) snapshots previous versions on update (PR #10)

## Knowledge base

Plain markdown files at `~/Library/Application Support/Compass/knowledge-base/<category>/<file>.md`.
- Auto-seeded on first launch from `electron/knowledge/writer.ts STARTER_FILES`
- Watched by `chokidar` — external edits re-index `knowledge_files` table + push `knowledge:file-changed` event
- Auto-updated files (e.g. `calendar/upcoming.md`, `inbox/action-items.md`) get a `.prev` snapshot saved before each overwrite (PR #10), enabling the diff view

## IPC handler map (~80 handlers)

Registered in `electron/main.ts`:
- `registerAuthHandlers` — OAuth flows
- `registerSyncHandlers` — sync trigger, status, event log
- `registerKnowledgeHandlers` — file CRUD, search, prev snapshot, suggestions accept/dismiss, **backlinks (Phase 5.3: `knowledge:get-backlinks`)**, **semantic search (Phase 5.9): `knowledge:get-embedding-status`, `knowledge:rebuild-embeddings`, `knowledge:semantic-search`** — backed by `electron/knowledge/embeddings.ts` and a JSON-on-disk index at `.data/knowledge-embeddings.json`
- `registerVaultHandlers` — entry CRUD, 1Password CSV import, history
- `registerSettingsHandlers` — get/set/getAll, data export, wipe, **per-integration sync interval**, Ollama detect, quick-capture shortcut
- `registerFinanceHandlers` — txns, accounts, debt summary, budget, rules, **geo summary, tax summary + override (Phase 4.3), net-worth snapshot/trajectory + capture + manual balance (Phase 4.4), forecast + override CRUD (Phase 4.5), tax-pack export (Phase 5.4: `finance:export-tax-pack`)**
- `registerHabitsHandlers` — habit CRUD + toggle entries
- `registerUpdaterHandlers` — `updater:check`, `updater:install-and-restart`; pushes `updater:status` events to renderer
- `registerCompassUrlScheme` (in `electron/url-scheme.ts`) — registers the `compass://` protocol handler (`capture`, `open/<page>`, `search`); routes URLs from `open-url` (macOS) and `second-instance` (Win/Linux) into IPC events the renderer consumes. `electron/integrations/apple-calendar.ts` adds `syncAppleCalendar` (Phase 5.7) which is dispatched from `sync.ts` for the `apple-calendar` service.
- `registerBackupHandlers` — `backup:create`, `backup:restore` (Phase 5.1, passphrase-derived AES-256-GCM)
- `registerSearchHandlers` — `search:global` (Phase 5.2; knowledge bodies + vault titles + tasks + transactions)
- `registerAssistantHandlers` — Ask Compass (Phase 5.12): `assistant:get-status`, `assistant:set-key`, `assistant:clear-key`, `assistant:set-active-provider`, `assistant:set-model`, `assistant:ask`, `assistant:cancel`. BYO Anthropic/OpenAI keys are encrypted via `crypto-vault` primitives at `.vault/assistant.enc`. The raw key never crosses the IPC boundary after being set; the renderer reads only a masked tail through `getStatus`. `assistant:ask` composes Phase 5.9 semantic search (top-K cosine over `.data/knowledge-embeddings.json`) with a keyword-scan fallback when no embedding index exists, then issues a non-streaming HTTP request to the active provider from the main process. CSP-free because main-process fetch isn't constrained.

Pattern: every IPC handler lives in `electron/ipc/<domain>.ts`, is exposed through `electron/preload.ts`, and has a TypeScript signature in `src/types/electron.d.ts`. Drift between these three is the leading source of bugs — see `electron-trpc` migration plan in `docs/implementation_plan.md` Phase 0.7.

## Pages & top-level components

| Route | Component |
|---|---|
| `/dashboard` | `src/pages/Dashboard.tsx` |
| `/daily` | `src/pages/Daily.tsx` |
| `/weekly` | `src/pages/Weekly.tsx` |
| `/monthly` | `src/pages/Monthly.tsx` |
| `/knowledge` | `src/pages/KnowledgeBase.tsx` |
| `/vault` | `src/pages/Vault.tsx` (with `setContentProtection` while mounted) |
| `/integrations` | `src/pages/Integrations.tsx` |
| `/finance` | `src/pages/Finance.tsx` |
| `/settings` | `src/pages/Settings.tsx` |

Layout shell: `src/components/layout/AppLayout.tsx` (Sidebar + main + ContextDrawer).
Global ⌘K palette: `src/components/CommandPalette.tsx` (mounted in `App.tsx`).

## Sync flow (per integration)

1. User clicks Connect → `auth:connect-<service>` opens OAuth window
2. Tokens encrypted via `safeStorage`, saved to `~/Library/Application Support/Compass/.vault/oauth-<service>.enc`
3. `node-cron` schedules background sync at `syncInterval` minutes
4. On tick: fetch API → upsert into DB tables → call `extractor.ts` to update markdown files → push `sync:update` event to renderer
5. Renderer cards refresh on event

## Background processes

- `chokidar` watcher on `knowledge-base/` for external edits
- `node-cron` scheduler in `electron/cron.ts`:
  - Per-integration sync (interval from `integrations.syncIntervalMinutes`, default 15m)
  - Nightly net-worth balance snapshot at 00:05 local time (Phase 4.4)
- Native theme listener (re-emits to renderer on macOS dark/light flip)
- `electron-updater` — checks GitHub Releases 3 s after launch, then every 4 h; downloads silently; notifies renderer via `updater:status` push events

## Release pipeline

Shipping a new version to all running Compass instances:

```bash
npm version patch          # bumps package.json + creates git tag (e.g. v0.1.1)
git push --follow-tags     # triggers .github/workflows/release.yml
```

GitHub Actions (`release.yml`) runs on `macos-latest`, installs deps, builds via `npm run release`
(`electron-builder --publish always`), and uploads `.dmg` + `latest-mac.yml` to GitHub Releases
using the auto-injected `GITHUB_TOKEN`. Because auto-updated macOS builds must be signed, the
workflow also requires repo secrets `CSC_LINK` and `CSC_KEY_PASSWORD` and fails fast if either
is missing.

The running app discovers the new `latest-mac.yml` on next check, downloads the `.dmg` in the
background, then shows the `UpdateBanner` with a "Restart to Install" CTA.

**Do not run `npm run release` locally** — CI builds are reproducible; local builds may differ.
