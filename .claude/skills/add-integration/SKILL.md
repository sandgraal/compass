---
name: add-integration
description: Step-by-step playbook for adding a new external service integration to Compass (Notion, Linear, Slack, Plaid, etc.). Auto-loads when the user mentions adding a new integration, connecting a service, or wiring up an external API. Covers DB schema, OAuth/PAT auth, sync function, knowledge extractor, frontend card, types, tests, and CSP allowlist.
---

# Adding a new integration

This is the canonical pattern, mirrored from how `google` and `github` are wired today. Read [`docs/integrations.md`](../../../docs/integrations.md) for the prose version.

## Files you'll touch (every integration touches all of these)

| File | What you add |
|---|---|
| `electron/db/schema.ts` | New table (or columns on existing) — delegate to `migration-author` |
| `electron/ipc/auth.ts` | OAuth handler `auth:connect-<service>` + `disconnect` (or PAT input) |
| `electron/ipc/sync.ts` | `sync<Service>()` function + dispatch in `sync:trigger` handler |
| `electron/knowledge/extractor.ts` | `update<Service>Knowledge(items)` function |
| `electron/preload.ts` | (only if new IPC namespace beyond auth/sync) |
| `src/types/electron.d.ts` | (only if new IPC namespace) |
| `src/pages/Integrations.tsx` | Append to `INTEGRATIONS` array + setup guide section |
| `electron/main.ts` | Add API hostname to CSP `connect-src` allowlist |

## Step-by-step

### 1. Plan
Decide:
- Data shape (what to fetch from the API)
- DB tables (new vs reuse existing)
- Knowledge file path (e.g. `work/notion-summary.md`)
- OAuth scopes (be minimal — read-only when possible)
- Setup guide steps (does the user need to register their own OAuth app?)

### 2. DB schema
If you need a new table, **delegate to `migration-author` subagent**. Brief them with the column list.
If you're adding columns to an existing table, do it inline + run `npm run db:generate`.

### 3. OAuth or PAT handler
- **OAuth (full flow)**: copy `auth:connect-google` from `electron/ipc/auth.ts` line ~283. Adjust authorize URL, token URL, scopes, redirect.
- **PAT (simpler)**: copy the GitHub-PAT-fallback pattern. Take a string from the renderer, encrypt via `safeStorage`, write to `<service>.enc`.

In both cases:
- Token storage uses `saveToken('<service>', tokenData)` from auth.ts
- Read with `loadToken('<service>')`
- Delete with `deleteToken('<service>')`
- Always update the `integrations` table row with status + last sync

### 4. Sync function
Add to `electron/ipc/sync.ts`:
```typescript
export async function sync<Service>(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const tokens = loadToken('<service>') as { access_token?: string } | null
  if (!tokens?.access_token) return { service: '<service>', success: false, error: 'Not connected' }

  const db = getDb()
  const integrationId = getIntegrationId(db, '<service>')
  let recordsUpdated = 0

  try {
    const headers = { Authorization: `Bearer ${tokens.access_token}` }
    const resp = await fetch('<API URL>', { headers })
    if (resp.ok) {
      const data = await resp.json()
      for (const item of data.items) {
        db.insert(<table>).values({ /* ... */ })
          .onConflictDoUpdate({ target: <table>.externalId, set: { /* ... */ } })
          .run()
        recordsUpdated++
      }
      await update<Service>Knowledge(data.items)
    }

    db.update(integrations).set({ lastSyncedAt: new Date(), status: 'connected', errorMessage: null })
      .where(eq(integrations.service, '<service>')).run()
    if (integrationId !== null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated }).run()
    }
    mainWindow?.webContents.send('sync:update', { service: '<service>', status: 'success', recordsUpdated })
    return { service: '<service>', success: true, recordsUpdated }
  } catch (err) {
    const message = (err as Error).message
    db.update(integrations).set({ status: 'error', errorMessage: message })
      .where(eq(integrations.service, '<service>')).run()
    if (integrationId !== null) {
      db.insert(syncEvents).values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message }).run()
    }
    mainWindow?.webContents.send('sync:update', { service: '<service>', status: 'error', error: message })
    return { service: '<service>', success: false, error: message }
  }
}
```

Then add to `sync:trigger`:
```typescript
if (service === '<service>') return sync<Service>(win)
```

### 5. Knowledge extractor
Add to `electron/knowledge/extractor.ts`:
```typescript
export async function update<Service>Knowledge(items: <Type>[]): Promise<void> {
  if (!items.length) return
  const lines = [
    '# <Service> Summary',
    '',
    `> Auto-updated by Compass — ${new Date().toLocaleString()}`,
    ''
  ]
  // ... build markdown table or list ...
  await updateKnowledgeFile(KNOWLEDGE_DIR, '<category>/<file>.md', lines.join('\n'))
}
```

`updateKnowledgeFile` automatically writes a `.prev` snapshot for the diff view.

### 6. Frontend card
In `src/pages/Integrations.tsx`, append to `INTEGRATIONS`:
```typescript
{
  id: '<service>',
  name: '<Display Name>',
  description: '<one-sentence>',
  scopes: ['<scope1>', '<scope2>'],
  color: 'from-<from>/20 to-<to>/20',
  logo: '<letter>'
}
```

If OAuth, add a setup guide section matching the Google/GitHub pattern.

### 7. CSP allowlist
In `electron/main.ts`, add the API hostname to `connect-src`. Don't forget the OAuth host if separate.

### 8. Tests
- Vitest unit test for the sync transformer (`electron/ipc/sync.<service>.test.ts`) — mock the API response, verify DB rows
- Playwright smoke test for the connect flow (skip in CI if it requires real OAuth)

### 9. Verify
```bash
npm run typecheck && npm run check && npm test && npm run build
```

### 10. Changeset
```bash
npx changeset
# minor bump, "Add <Service> integration with calendar/<thing> sync"
```

### 11. PR
Use the standard template. Include:
- Screenshots of the integration card
- Setup steps the user needs to follow
- API endpoints called
- New CSP entries

## Anti-patterns (don't do these)

- ❌ Storing tokens unencrypted on disk
- ❌ Sending tokens to the renderer
- ❌ Polling without `node-cron` (creates orphan timers)
- ❌ Forgetting `onConflictDoUpdate` (creates duplicate rows on every sync)
- ❌ Forgetting to update `sync_events` (no error log = no debuggability)
- ❌ Inventing a new IPC pattern — match what google/github do
