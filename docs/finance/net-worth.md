# Net worth

## Goal

True net-worth view: liabilities (already tracked) plus assets (currently
nowhere). The savings rate is meaningless until we know where the saved money
is going.

## Why now

The dashboard shows $19,400 in debt and a 36 % savings rate. That tells you
nothing about whether net worth is climbing — half the saved money is going
into a CR construction asset and half into bank reserves, but neither shows up.
A 12-month wealth trajectory chart with both sides resolves this.

## Acceptance criteria

- [ ] New tab on `Finance.tsx`: **Net Worth** (between *Forecast* and *Transactions*).
- [ ] Asset balances editable in **Accounts** tab — every spending account
      gains an editable `currentBalance` field, plus a new **Manual asset**
      account type for things without a transaction stream (CR property,
      collectibles).
- [ ] Snapshot table at the top: `Total assets — Total liabilities = Net worth`,
      with delta vs 30 days ago, vs 90 days ago, vs 1 year ago.
- [ ] Trajectory chart: line per category (`bank`, `retirement`, `real_estate`,
      `liabilities`), stacked area or grouped lines, monthly granularity, going
      back to first available snapshot.
- [ ] Snapshot capture: cron job at midnight local time writes one row per
      account into `finance_balance_snapshots`. User can also trigger via
      "Capture snapshot" button on the Accounts tab.
- [ ] Inferred balances: for accounts that *have* transactions, the snapshot
      cron computes `lastKnownBalance + sum(txns since last snapshot)`. Manual
      assets only update on user edit.

## Approach

### Schema additions

```ts
// electron/db/schema.ts
// 1. Asset class on accounts
//    Add column to financeAccounts:
//      assetClass: text('asset_class').default('spending')
//    Values: 'spending' | 'savings' | 'retirement' | 'real_estate' |
//            'manual_asset' | 'liability' (liability is for isDebt=true rows)

// 2. Snapshot table
export const financeBalanceSnapshots = sqliteTable('finance_balance_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').references(() => financeAccounts.id).notNull(),
  capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
  balance: real('balance').notNull(),
  source: text('source').notNull()  // 'manual' | 'inferred' | 'plaid'
})
```

Index on `(accountId, capturedAt DESC)` for fast latest-balance lookups.

### Inference logic

For accounts with transactions, the cron computes nightly:

```
new_balance = previous_snapshot.balance + Σ(txns where date > previous_snapshot.capturedAt)
```

For manual-asset accounts (CR property, etc.), no inference. User edits the
balance manually; that creates a `manual` snapshot.

### IPC

- `finance:get-net-worth-snapshot` → `{ assets, liabilities, net, deltas: { 30d, 90d, 365d } }`
- `finance:get-net-worth-trajectory` → `{ series: [{ date, accountId, balance }] }`
- `finance:capture-snapshot` → forces a capture for all accounts now
- `finance:set-account-balance` → manual override, writes a `manual` snapshot

### UI

- Net Worth tab:
  - Top: 4-tile snapshot (Assets / Liabilities / Net / Δ)
  - Middle: trajectory chart (Recharts area)
  - Bottom: per-account table sorted by balance, with inline edit for
    manual-asset rows
- Accounts tab additions:
  - `assetClass` dropdown when adding/editing
  - "Set balance" button on every row → opens dialog, writes a manual snapshot

### Cron

Add to `electron/cron.ts`: `runFinanceSnapshot()` every 24 h (00:05 local
time). Idempotent — if a snapshot for today already exists for an account,
skip it.

## Test coverage required

- `finance-snapshot.test.ts`:
  - Inferred balance from previous snapshot + new txns is correct
  - Manual asset only writes when user edits
  - Snapshot is idempotent within a day
  - Net-worth trajectory query returns balances on dates with no captures by
    forward-filling
  - 30 / 90 / 365-day deltas correct

## Out of scope

- Plaid live balances (depends on [`plaid-integration.md`](plaid-integration.md);
  when that lands, the inference cron is replaced with Plaid's `accounts/balance/get`).
- Investment performance attribution (cost basis, unrealized P&L). v2.
- Currency hedging for CR Costa Rica colón exposure. The CR build is paid in USD
  via card and ATM, so this isn't a near-term concern.

## Suggested driver

`migration-author` for the schema; `integration-implementer` for the inference
+ snapshot cron; `ui-polish` for the trajectory chart and editor.

Single PR, medium-large (~700–900 LOC). Could split into
"snapshots backend" + "Net Worth tab" if a smaller PR is preferred.
