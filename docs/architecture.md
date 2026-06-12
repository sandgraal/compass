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
| Obsidian vault bridge (two one-way markdown mirrors) | `electron/integrations/obsidian.ts`, `electron/ipc/obsidian.ts` |
| Notion import (shared pages → `knowledge-base/notion/`) | `electron/integrations/notion.ts` (+ `auth:connect-notion` in `electron/ipc/auth.ts`) |

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
| `claude_proposals` | Claude Inbox queue (Phase 8.2). Proposals the read-only MCP appended to `.data/claude-inbox.jsonl`, ingested here (dedup by MCP `proposal_id`) with `status` (`pending`/`approved`/`rejected`/`failed`); approve applies via validated write logic. Migration `0010`. |

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
- `registerAuthHandlers` — OAuth flows + paste-once token handlers (`auth:connect-github-pat`; **`auth:connect-notion`** — Notion internal-integration token validated against `/v1/users/me`, encrypted via the standard `saveToken` path; Notion's own page-sharing model is the consent surface)
- `registerSyncHandlers` — sync trigger, status, event log
- `registerKnowledgeHandlers` — file CRUD, search, prev snapshot, suggestions accept/dismiss, **backlinks (Phase 5.3: `knowledge:get-backlinks`)**, **semantic search (Phase 5.9): `knowledge:get-embedding-status`, `knowledge:rebuild-embeddings`, `knowledge:semantic-search`** — backed by `electron/knowledge/embeddings.ts` and a JSON-on-disk index at `.data/knowledge-embeddings.json`
- `registerVaultHandlers` — entry CRUD, 1Password CSV import, history
- `registerSettingsHandlers` — get/set/getAll, data export, wipe, **per-integration sync interval**, Ollama detect, quick-capture shortcut
- `registerFinanceHandlers` — txns, accounts, debt summary, budget, rules, **geo summary, tax summary + override (Phase 4.3), net-worth snapshot/trajectory + capture + manual balance (Phase 4.4), forecast + override CRUD (Phase 4.5), tax-pack export (Phase 5.4: `finance:export-tax-pack`)**
- `registerHabitsHandlers` — habit CRUD + toggle entries
- `registerClaudeHandlers` — Claude Inbox (Phase 8.2): `claude:list-proposals` (ingests `.data/claude-inbox.jsonl`, dedup by MCP `proposal_id`), `claude:approve-proposal` (re-validates the LLM-written payload, then applies via the same write logic — `safeJoin` path-safety, shared `TAX_TAGS` whitelist, list-type domain, strict booleans — recording `approved`+`resultRef` or `failed`+error), `claude:reject-proposal`, `claude:clear-resolved` (**soft**-clears — stamps `cleared_at` so the row drops out of the inbox but survives for dedup, since the append-only JSONL is never truncated). The vault is never touched.
- `registerUpdaterHandlers` — `updater:check`, `updater:install-and-restart`; pushes `updater:status` events to renderer
- `registerCompassUrlScheme` (in `electron/url-scheme.ts`) — registers the `compass://` protocol handler (`capture`, `open/<page>`, `search`); routes URLs from `open-url` (macOS) and `second-instance` (Win/Linux) into IPC events the renderer consumes. `electron/integrations/apple-calendar.ts` adds `syncAppleCalendar` (Phase 5.7) which is dispatched from `sync.ts` for the `apple-calendar` service.
- `registerBackupHandlers` — `backup:create`, `backup:restore` (Phase 5.1, passphrase-derived AES-256-GCM)
- `registerSearchHandlers` — `search:global` (Phase 5.2; knowledge bodies + vault titles + tasks + transactions)
- `registerMorningBriefHandlers` — `morning-brief:get` (Phase 7 Track A): a single server-side digest of "what matters today" — today's calendar events (local-day window) + unchecked daily tasks + debt payments due ≤7 days + unresolved Gmail inbox actions + an optional **low-cash alert** + a summary string. Rendered by `src/components/MorningBrief.tsx` atop the Dashboard. `buildMorningBrief(db, now, lowCash)` is a pure assembler (the low-cash section is injected); it's reused by `notifyMorningBrief` — an optional **daily OS notification** scheduled in `cron.ts` (via `morningBriefCronExpr`) at the `morningBriefNotifyTime` setting (Settings ▸ Notifications), re-scheduled by `restartCronJobs()` when that setting changes. The **low-cash alert** is opt-in (`lowCashAlertEnabled` + `lowCashThreshold` settings): `computeLowCashAlert` runs the Phase 4.5 cash-flow forecast (`buildForecast`) over a 14-day horizon at the IPC/cron boundary and surfaces the soonest projected dip below the threshold across cash (non-debt) accounts. The **price-hike alert** is similarly opt-in (`priceHikeAlertEnabled`): `computePriceHikeAlert` runs the subscription audit (`auditSubscriptions`, which computes recent-vs-historical median deltas per active recurring charge) and the pure `buildPriceHikeAlert` keeps the largest-delta hikes. Both alert computations live outside the pure assembler (the forecast needs raw SQLite; the audit runs the recurring-transaction scan) and are injected into `buildMorningBrief`.
- `registerWeeklyReviewHandlers` — `weekly-review:get` + `weekly-review:carry-over` (Phase 7 Track A): the data side of the Weekly page's close-out. `buildWeeklyReview(db, weekStartYmd)` (pure, exported) computes the week's completion (done/total/%), the week-over-week delta vs the prior 7 days, a Mon..Sun per-day breakdown, and the carry-over candidates (unchecked **manual** daily items). `weekly-review:carry-over` copies those unfinished tasks forward to a target day (default today), skipping titles already present so it's safe to re-run. Surfaced as a "carry N unfinished → today" action in `src/pages/Weekly.tsx`.
- `registerMonthlyRollupHandlers` — `monthly-rollup:get` (Phase 7 Track A): the data side of the Monthly page's end-of-month review. `buildMonthlyRollup(db, month)` (pure, exported; `month` is a `YYYY-MM` key) computes the calendar month's completion (done/total/%), the month-over-month delta vs the previous calendar month, and a per-week breakdown — each overlapping ISO week (Mon..Sun) reuses `buildWeeklyReview` so the two rituals stay numerically consistent — plus the best week. Surfaced as a "Task Completion" card (month %, MoM delta, per-week bars, best week) in `src/pages/Monthly.tsx`.
- `registerObsidianHandlers` — Obsidian vault bridge (Phase 7 Track B): `obsidian:get-status` (re-validates the stored path each call so a moved vault surfaces), `obsidian:set-vault-path` (validated: existing dir, no nesting either way with the app data dir; persists `obsidianVaultPath` + upserts the `integrations` row), `obsidian:clear`. The sync itself is `syncObsidian` in `electron/integrations/obsidian.ts`, dispatched via `sync:trigger('obsidian')`, `sync:trigger-all` (only when configured), and the per-integration cron. Two one-way mirrors with disjoint namespaces (vault → `knowledge-base/obsidian/`, knowledge-base minus `obsidian/` → `<vault>/Compass/`) so nothing round-trips; `<vault>/Compass` is only adopted if Compass created it (`.compass-mirror` marker), otherwise the sync aborts rather than pruning user notes.
- `registerInsightsHandlers` — `insights:get` (Phase 7 Track E): one read-only aggregator of local-only proactive nudges, rendered as the "Worth a look" Dashboard card (`src/components/ProactiveInsights.tsx`). `buildInsights(db, now)` (pure, exported) runs four detectors: **spending anomalies** (current-month category spend ≥1.5× the trailing-3-month average AND ≥$50 over; Transfers/Uncategorized excluded; top 3 by dollar delta), **uncategorized spend** (count/total floors over a 60-day window), **habit slippage** (≥50% completion over the prior 3 weeks but ≤1 check-in this week), and **stale notes** (user-authored, non-mirror, non-auto-updated files untouched 90+ days). Thresholds are exported consts; no network, no LLM, no writes.
- `registerQuickCaptureHandlers` — `quick-capture:submit` (Phase 7 Track A): backend for the tray / global-shortcut capture bar. Three kinds: `task` (checklist_items row for today, same semantics as `checklist:quick-add`), `note` (timestamped bullet appended to `knowledge-base/inbox/quick-capture.md`), `expense` (parses "12.50 coffee" / "coffee 12.50" via the exported `parseExpense`, then runs the same `categorize` → `tagGeoAndPurpose` → `tagTax` pipeline as CSV/Plaid ingest; the dedupe hash is salted with the capture instant so two identical captures in one day both land). Reached only through the minimal `preload-quick-capture.ts` bridge — `window.api` is not exposed in the capture window.
- `registerAssistantHandlers` — Ask Compass (Phase 5.12): `assistant:get-status`, `assistant:set-key`, `assistant:clear-key`, `assistant:set-active-provider`, `assistant:set-model`, `assistant:ask`, `assistant:cancel`, **`assistant:agent` (Phase 8.5)**. The agent is an Anthropic tool-use loop (`electron/integrations/assistant-tools.ts` defines read tools `get_upcoming`/`get_finance_summary`/`get_week_tasks`/`get_weekly_goals`/`get_habit_streaks`/`get_insights` — the latter four added for the Phase 7 Track E "plan my week" flow — plus a `propose_task` tool that enqueues a `pending` `claude_proposals` row — never a direct write); the Anthropic client (`llm-client.ts`) gained tool-use + `cache_control` prompt caching. Vault excluded; finance summaries only; OpenAI keeps the single-shot `ask` path. BYO Anthropic/OpenAI keys are encrypted via `crypto-vault` primitives at `.vault/assistant.enc`. The raw key never crosses the IPC boundary after being set; the renderer reads only a masked tail through `getStatus`. `assistant:ask` composes Phase 5.9 semantic search (top-K cosine over `.data/knowledge-embeddings.json`) with a keyword-scan fallback when no embedding index exists, then issues a non-streaming HTTP request to the active provider from the main process. CSP-free because main-process fetch isn't constrained.

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
| `/ask` | `src/pages/Ask.tsx` (Phase 5.12 RAG assistant) |
| `/claude-inbox` | `src/pages/ClaudeInbox.tsx` (Phase 8.2 — review/approve Claude proposals) |

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

## Claude / MCP boundary

- `mcp/compass-mcp/index.ts` is a **separate, read-only** MCP process (opens the DB with `readonly: true`). It exposes a curated set of read tools (tasks, knowledge, calendar, sync, repo introspection) — **the vault and raw finance rows are excluded.** Registered for Claude Code via `.mcp.json`.
- **Proposed (Phase 8, not built):** Claude *proposes* writes — the MCP appends them to a **separate, append-only inbox it owns read-write** (`.data/claude-inbox.jsonl`, distinct from the read-only `compass.db`), never to `compass.db` itself. The running app watches that inbox, surfaces a **Claude Inbox** for human approval, then executes the real change through the existing validated write IPC. Full design: [`claude-integration.md`](claude-integration.md). The boundary rule mirrors the renderer's: untrusted callers never mutate `compass.db`; the main process is the sole, validating writer.

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
