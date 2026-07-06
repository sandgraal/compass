# Adding a new integration

Use the `add-integration` skill (`.claude/skills/add-integration/SKILL.md`) to drive this end-to-end. The pattern below mirrors what the `google` and `github` integrations do.

## Steps

### 1. Pick the data shape
What data are you syncing? Pick or create a table in `electron/db/schema.ts`. Examples:
- Notion → `notion_pages` table (id, title, url, lastEdited, syncedAt)
- Linear → its own `linear_issues` table (`electron/db/schema.ts`) — already shipped this way (PAT-based, see `electron/integrations/linear.ts`); use it as the reference example for a PAT integration with a dedicated table
- Slack → `slack_action_items` (similar to `gmail_actions`)

If new table → run the `migration-author` subagent to generate the Drizzle migration.

### 2. Add the integration row
On first connect, ensure a row exists in `integrations` with `service='<name>'`. There's no shared helper for this — each OAuth/PAT handler does a raw `db.insert(integrations).values({ service: '<name>', ... })` inline. Copy the pattern from an existing handler in `electron/ipc/auth.ts` (google, github) or a PAT module like `electron/integrations/linear.ts` / `electron/integrations/notion.ts`.

### 3. OAuth flow (or PAT input)
- OAuth: copy the pattern from `auth:connect-google` or `auth:connect-github` in `electron/ipc/auth.ts`. Use a child `BrowserWindow` for the redirect.
- Personal Access Token: simpler — IPC handler accepts the token, encrypts via `safeStorage`, saves to `oauth-<service>.enc`.
- **Always store tokens encrypted.** Never plaintext on disk, never sent to renderer.

### 4. Sync function
Add `sync<Service>()` in its own module, `electron/integrations/<service>.ts` (this is the actual current pattern — e.g. `syncNotion` in `electron/integrations/notion.ts`, `syncLinear` in `electron/integrations/linear.ts`, `syncTodoist` in `electron/integrations/todoist.ts`). `electron/ipc/sync.ts` only holds the handful of original inline sync functions (`syncAppleCalendar`, `syncGoogle`, `syncGitHub`) plus imports every other service's function purely for dispatch:
```ts
import { syncLinear } from '../integrations/linear'
```
Your module should:
- Take an optional `mainWindow` for progress events
- Look up the integration row, get `integrationId` for `sync_events` logging
- Auth headers from decrypted token
- Fetch → upsert into your table (use `onConflictDoUpdate` for idempotency)
- On success: update `integrations.lastSyncedAt`, insert `sync_events` row, push `sync:update` event
- On error: update `integrations.errorMessage`, insert failed `sync_events` row, push `sync:update` with `error`

### 5. Knowledge extractor
Add `update<Service>Knowledge(items)` to `electron/knowledge/extractor.ts`:
- Generate markdown from the latest data (table format works well)
- Top of file: `> Auto-updated by Compass on each sync.`
- Call `updateKnowledgeFile(KNOWLEDGE_DIR, '<category>/<file>.md', content)` — this auto-writes a `.prev` snapshot for the diff view

### 6. Schedule
- `electron/cron.ts` already schedules one cron task **per integration row**: `startCronJobs()` reads every row in `integrations`, resolves its `syncIntervalMinutes` (falling back to the legacy global `appSettings.syncInterval`), and calls `scheduleForService(service, interval)` for each — so your new row gets its own independently-configurable schedule automatically, no extra registration needed.
- Add your service to the dispatch table in `runSyncForService(service)` in `cron.ts` so the scheduled tick actually calls your sync function.
- After changing the `integrations` table (new row, interval edit), call `restartCronJobs()` (no args — it re-derives every schedule from the table) rather than trying to target one service.
- `sync:trigger` IPC handler dispatches to your sync function based on `service` arg.

### 7. Frontend
- Add one entry to `INTEGRATION_REGISTRY` in `src/lib/integration-registry.ts` (id, name, category,
  method, description, scopes, color, logo letter, `connected: true`). This is the single source of
  truth both `Sidebar.tsx` (connected-count summary) and `Integrations.tsx` (category-grouped,
  searchable grid) read from — no per-page array to hand-maintain anymore.
- **Add a matching `INTEGRATION_SETUP` entry** in `src/lib/integration-setup.ts` (same `id`). This is
  the declarative "how to connect" spec — `authKind`, `requiresRelay`, `byoSupported`, `cost`,
  `prerequisites`, `whatYoullNeed`, numbered `steps` (with links), `docUrl`/`signupUrl`, and the
  credential `fields` for the generic form. The parity test (`integration-setup.test.ts`) fails if a
  connected registry entry has no setup entry, so this is required, not optional.
- The card UI auto-renders from the registry + setup spec via `<IntegrationCard>` + `<IntegrationSetupPanel>`
  (`src/components/integrations/`). For the simple auth kinds (`paste-token`, `relay-widget`, `local-file`)
  the panel renders the whole connect flow from the spec — no per-service JSX. The multi-field /
  multi-connection / stateful flows (Google, Plaid, SimpleFIN, SnapTrade, and Obsidian — `local-path`)
  keep bespoke JSX, slotted via `renderCardBody` in `Integrations.tsx`.
- Setup guide entry: append to the OAuth setup guide section in `Integrations.tsx` if the user needs to
  create their own OAuth app.
- Relay-fronted aggregators route through `electron/integrations/relay-client.ts`; they need a reachable
  relay (`relay:` IPC + the Relay Settings panel let a user self-host — see `relay/README.md`).

### 8. CSP allowlist
Every real integration needs its outbound host reachable under the production CSP. In `electron/main.ts`, add the API hostname to the `connect-src` allowlist. Don't forget the OAuth host too, if it's a separate domain from the API host. Skipping this step means the integration works in dev (no CSP) but silently fails to fetch in a packaged build.

### 9. Optional: dedicated page
If the data warrants its own view (like Finance), use the `add-page` skill.

## Checklist

- [ ] Schema added (and migration generated if new table)
- [ ] OAuth or PAT IPC handler in `electron/ipc/auth.ts` (or a PAT module under `electron/integrations/`)
- [ ] Sync function in its own `electron/integrations/<service>.ts` module, imported into `electron/ipc/sync.ts` for dispatch
- [ ] Knowledge extractor in `electron/knowledge/extractor.ts` (or its own sibling module — see `docs/knowledge-extractor.md`)
- [ ] Frontend registry entry in `src/lib/integration-registry.ts`
- [ ] Declarative setup entry in `src/lib/integration-setup.ts` (enforced by `integration-setup.test.ts`)
- [ ] Setup guide in the same file (if OAuth)
- [ ] Type for the new `window.api.<service>.*` namespace in `src/types/electron.d.ts`
- [ ] CSP `connect-src` entry in `electron/main.ts` for the API host (and OAuth host if separate)
- [ ] Test: connect → trigger sync → verify rows in table + markdown file updates
- [ ] Add a Vitest unit test for the sync transformer (mock the API response)
