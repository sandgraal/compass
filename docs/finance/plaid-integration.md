# Plaid integration

## Goal

Replace the manual "Sunday CSV download from each bank" ritual with live,
read-only Plaid syncs. Compass already has the file-watcher pipeline; Plaid
becomes a second-class ingest source that emits the same `RawTxn[]` and
flows through the existing categorize → dedupe → tag → store path.

## Why now

The Sunday ritual is the single biggest friction point in the loop. Per the
weekly-review SKILL, the user has to log into 4–6 institutions, navigate to
download, pick the right CSV format, save to `~/Documents/Money`, then come
back to Compass. Plaid does this in 200 ms via API. The ingest pipeline
downstream is identical.

This is **also** the place where the existing
`electron/integrations/plaid.ts` reference in
`electron/integrations/finance.ts:1-7` becomes real.

## Acceptance criteria

- [ ] Plaid Link flow inside Compass: user clicks "Connect bank" in
      Integrations → Plaid Link modal opens (in a child `BrowserWindow`) →
      user authenticates → Compass receives `access_token` and stores it
      encrypted in `.vault/plaid.enc`.
- [ ] Per-institution sync: `syncPlaid(institutionId)` fetches transactions
      since `cursor`, normalizes to `RawTxn`, runs the existing categorize +
      tag + dedupe pipeline, persists, and writes the cursor for next time.
- [ ] Same status-event surface as other integrations:
      `integrations.lastSyncedAt`, `sync_events`, `sync:update` IPC event.
- [ ] Account onboarding: when Plaid returns accounts, auto-create
      `financeAccounts` rows with `plaidItemId` + `plaidAccountId` foreign keys.
      Existing accounts (matched by `mask` last-4) get linked, not duplicated.
- [ ] Daily cron at 06:00 local re-syncs all connected institutions.
      Manual "Sync now" button on the Integrations card.
- [ ] CSV ingest path remains intact as a backstop. Watcher folder still
      works.
- [ ] No PII in markdown / knowledge-base. Account masks (`****1234`) only.

## Approach

### Tier strategy

| Tier | Plaid env | Purpose |
|---|---|---|
| Sandbox | `sandbox` | CI tests, fixture-driven |
| Development | `development` | First 100 connected accounts free; use this for the user's actual accounts during build-out |
| Production | `production` | When the auth + sync loop is rock-solid; usage-billed |

User's `~/.config/compass/plaid.env` holds non-secret config only:

```
PLAID_CLIENT_ID=...
PLAID_ENV=development
```

Secrets (`PLAID_SECRET_DEV`/`PLAID_SECRET_PROD`) and access tokens are encrypted
via `safeStorage` and stored in `.vault/plaid-config.enc` to keep the same
security envelope as other tokens.

### Schema additions

```ts
// electron/db/schema.ts
export const plaidItems = sqliteTable('plaid_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemId: text('item_id').notNull().unique(),    // Plaid's item_id
  institutionId: text('institution_id').notNull(),  // ins_NN
  institutionName: text('institution_name').notNull(),
  cursor: text('cursor'),                         // for /transactions/sync pagination
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
  errorCode: text('error_code'),                  // ITEM_LOGIN_REQUIRED etc.
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// Add to financeAccounts:
plaidItemId: integer('plaid_item_id').references(() => plaidItems.id),
plaidAccountId: text('plaid_account_id'),  // unique within an item
mask: text('mask'),                         // last-4
```

Migration is a column add (existing rows nullable, no data loss).

### Module layout

```
electron/integrations/plaid/
  index.ts           — public sync API: syncPlaid, syncAllPlaid, connectInstitution
  client.ts          — thin wrapper around the official `plaid` npm SDK
  link.ts            — Plaid Link token creation + redirect handling
  normalize.ts       — Plaid Transaction → RawTxn (uses the shared categorize fn)
  cursor.ts          — cursor read/write helpers
electron/ipc/plaid.ts — registerPlaidHandlers(ipcMain)
```

### Plaid → RawTxn mapping

```
date: plaidTxn.date                              (already 'YYYY-MM-DD')
amount: -plaidTxn.amount                         (Plaid is debit-positive; flip)
description: plaidTxn.merchant_name ?? plaidTxn.name
account: financeAccounts.find(plaidAccountId === plaidTxn.account_id).name
category: undefined                              (let our categorizer assign)
sourceFile: 'plaid:' + plaidItem.institutionName + ':' + plaidTxn.transaction_id
hash: hashTxn(date, amount, description, account)
```

The hash uses Plaid's natural fields, **not** Plaid's `transaction_id`, so a
CSV-then-Plaid migration doesn't double-count transactions.

### Sync loop

`syncPlaid(itemId)`:
1. Fetch cursor from `plaidItems.cursor`
2. Call `transactions/sync` with the cursor
3. For `added` + `modified`: normalize → run through `categorize()` →
   `tagGeoAndPurpose()` → upsert by hash
4. For `removed`: delete from `financeTransactions` by Plaid txn ID stored in
   `sourceFile`
5. Persist `next_cursor` to `plaidItems.cursor`
6. Update `integrations.lastSyncedAt`, write `sync_events` row

Pagination loop continues until `has_more === false`.

### Watcher coexistence

The watcher (`finance-watcher.ts`) keeps running. Both sources hit the same
hash dedupe so simultaneous CSV + Plaid imports don't duplicate. CSV is left
in place as a backstop and for institutions Plaid can't reach (small CR banks).

### Cron

Append to `electron/cron.ts`:

```ts
schedule('0 6 * * *', async () => {
  await syncAllPlaid()
})
```

### UI

- Integrations page: new "Plaid" card with connect/disconnect/sync-now
  controls; per-institution health (last sync, error state).
- Finance page Accounts tab: rows linked to Plaid show a small "linked" badge
  with institution name + mask; manual edit of balance is disabled (Plaid
  owns it).

## Security

- `safeStorage` encrypts the access token. Plaintext on disk never.
- Renderer never sees access tokens. All Plaid calls happen in main.
- `cspMain` extends to allow Plaid Link's redirect: `https://cdn.plaid.com`.
- Item disconnect calls Plaid's `/item/remove` and zeroes the vault entry.

## Test coverage required

- `plaid/normalize.test.ts`: Plaid txn → RawTxn shape, sign flip, hash stability
- `plaid/cursor.test.ts`: cursor read/write idempotency
- `plaid/sync.test.ts` (mocked client): happy path, ITEM_LOGIN_REQUIRED, removed
  txn handling
- Integration: spin up Plaid sandbox, connect a fake institution, sync,
  assert N transactions appear in DB with correct categories

## Out of scope

- Plaid Investments (holdings, securities). v2 — needed only if retirement
  net-worth tracking goes beyond manual edits.
- Plaid Identity. Compass doesn't need verified identity.
- Plaid Liabilities (loan/credit details beyond balance). The `financeAccounts.apr`
  /`minPayment` user-edit pattern is fine.

## Risks

- Plaid Link in an Electron child `BrowserWindow` can be flaky with CSP. Validate
  early; fall back to a system-browser flow if needed (`shell.openExternal`).
- Some CR institutions aren't on Plaid. The user's USAA + Amex coverage IS
  on Plaid; CR Banco Popular / Scotiabank-CR are not. Watcher fallback covers
  those.
- Free dev-tier limit: 100 Items. Should never bind for one user.

## Suggested driver

This is a multi-PR effort; recommend `director` agent orchestrate:

1. `migration-author` — schema additions
2. `integration-implementer` — Plaid client + sync loop
3. `security-auditor` — pre-merge review of token storage + IPC surface
4. `ui-polish` — Integrations card + Accounts linkage badge

Suggested PR sequence: schema → client → Link → sync → UI → cron. Each ~200–
400 LOC.
