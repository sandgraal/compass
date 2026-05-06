# Adding a new integration

Use the `add-integration` skill (`.claude/skills/add-integration/SKILL.md`) to drive this end-to-end. The pattern below mirrors what the `google` and `github` integrations do.

## Steps

### 1. Pick the data shape
What data are you syncing? Pick or create a table in `electron/db/schema.ts`. Examples:
- Notion → `notion_pages` table (id, title, url, lastEdited, syncedAt)
- Linear → reuse `github_items` with `repo` repurposed as `team`, or new `linear_issues`
- Slack → `slack_action_items` (similar to `gmail_actions`)

If new table → run the `migration-author` subagent to generate the Drizzle migration.

### 2. Add the integration row
On first connect, ensure a row exists in `integrations` with `service='<name>'`. Pattern is in `electron/ipc/auth.ts` (`registerService` helper).

### 3. OAuth flow (or PAT input)
- OAuth: copy the pattern from `auth:connect-google` or `auth:connect-github` in `electron/ipc/auth.ts`. Use a child `BrowserWindow` for the redirect.
- Personal Access Token: simpler — IPC handler accepts the token, encrypts via `safeStorage`, saves to `oauth-<service>.enc`.
- **Always store tokens encrypted.** Never plaintext on disk, never sent to renderer.

### 4. Sync function
Add `sync<Service>()` to `electron/ipc/sync.ts`:
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
- For now, the `cron.ts` schedules a single combined task. Once Phase 2.5 lands, you'll register your service with `restartCronJobsFor('<service>')`.
- `sync:trigger` IPC handler dispatches to your sync function based on `service` arg.

### 7. Frontend
- Add to `INTEGRATIONS` array in `src/pages/Integrations.tsx` (id, name, description, scopes, color, logo letter)
- Setup guide entry: append to the OAuth setup guide section if the user needs to create their own OAuth app
- The card UI auto-renders from the array

### 8. Optional: dedicated page
If the data warrants its own view (like Finance), use the `add-page` skill.

## Checklist

- [ ] Schema added (and migration generated if new table)
- [ ] OAuth or PAT IPC handler in `electron/ipc/auth.ts`
- [ ] Sync function in `electron/ipc/sync.ts`
- [ ] Knowledge extractor in `electron/knowledge/extractor.ts`
- [ ] Frontend card in `src/pages/Integrations.tsx`
- [ ] Setup guide in the same file (if OAuth)
- [ ] Type for the new `window.api.<service>.*` namespace in `src/types/electron.d.ts`
- [ ] Test: connect → trigger sync → verify rows in table + markdown file updates
- [ ] Add a Vitest unit test for the sync transformer (mock the API response)
