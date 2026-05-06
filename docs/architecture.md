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
| Drizzle schema | `electron/db/schema.ts`, `electron/db/schema.finance.ts` |
| DB singleton | `electron/db/client.ts` |
| Local data paths | `electron/paths.ts` |
| Vault encryption | `electron/ipc/vault.ts` |
| OAuth flows + token storage | `electron/ipc/auth.ts` |
| Sync logic per service | `electron/ipc/sync.ts` |
| Knowledge file write/read | `electron/knowledge/writer.ts` |
| Auto-update pipeline | `electron/knowledge/extractor.ts` |
| Finance ingestion + budget | `electron/ipc/finance.ts`, `electron/integrations/finance.ts` |

## Database (Drizzle / SQLite via `better-sqlite3`)

17 tables. Lives at `~/Library/Application Support/Compass/.data/compass.db`.

| Table | Purpose |
|---|---|
| `integrations` | One row per service (google, github). Status, scopes, last sync. |
| `sync_events` | Append-only log of every sync attempt (records updated, errors). |
| `checklist_items` | Daily/weekly/monthly tasks. Source = manual / github / calendar / gmail. |
| `checklist_templates` | User-edited markdown templates per list type. |
| `calendar_events` | Cached calendar events from any source. |
| `github_items` | Issues + PRs + project items. |
| `gmail_actions` | Action items extracted from Gmail. |
| `drive_files` | Google Drive file index. |
| `knowledge_files` | Index of `knowledge-base/*.md` files (path, title, word count). |
| `app_settings` | Key/value (`syncInterval`, `theme`, weekly goals JSON, etc.). |
| `finance_accounts` | Bank, credit, investment, debt accounts. |
| `finance_transactions` | Hashed for dedup; category/subcategory editable. |
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

## IPC handler map (~65 handlers)

Registered in `electron/main.ts`:
- `registerAuthHandlers` — OAuth flows
- `registerSyncHandlers` — sync trigger, status, event log
- `registerKnowledgeHandlers` — file CRUD, search, prev snapshot
- `registerVaultHandlers` — entry CRUD, 1Password CSV import
- `registerSettingsHandlers` — get/set/getAll, data export, wipe
- `registerFinanceHandlers` — txns, accounts, debt summary, budget, rules
- `registerHabitsHandlers` — habit CRUD + toggle entries

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
- `node-cron` scheduler in `electron/cron.ts`
- Native theme listener (re-emits to renderer on macOS dark/light flip)
