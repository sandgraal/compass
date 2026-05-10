# Cash-flow forecast

## Goal

A forward-looking 90-day cash-flow projection on the Finance page. Today's
dashboard is purely retrospective — this turns the question "did I do well last
month?" into "am I going to be short on the 18th?".

## Why now

The retrospective dashboard already shows what happened. The user's actual
goal — *getting on top of finances* — needs a forward view: project balance
trajectory by combining (a) detected subscription cadence, (b) recurring income
(payroll), (c) scheduled debt minimums + targets, (d) known calendar bills.

## Acceptance criteria

- [ ] New tab on `Finance.tsx`: **Forecast** (between *Overview* and *Transactions*).
- [ ] Single chart: balance trajectory per spending account, daily granularity, 90 days forward.
- [ ] Inflow and outflow events listed underneath, grouped by week, click-to-edit.
- [ ] "Cash low" warning banner if any account drops below a user-configured threshold (`appSettings.cashLowThreshold`, default $500) within the window.
- [ ] User can mark any forecasted event "skip", "shift to date X", or "amount Y"; the chart re-projects.
- [ ] Re-projection is deterministic and < 200 ms for 12 accounts × 90 days.

## Approach

### Data sources (all already in DB)

| Stream | Source | Notes |
|---|---|---|
| Recurring income | `financeTransactions` where `amount > 0`, cadence detected by `finance-subscriptions.ts`-style logic | Payroll, retainers |
| Subscription outflows | `auditSubscriptions(db).active` | Already implemented |
| Debt obligations | `financeAccounts` where `isDebt=true` — `minPayment` due monthly on the user's chosen day | New column: `paymentDayOfMonth` (default 1) |
| Calendar bills | `calendar_events` filtered by finance keywords | Already wired in `dashboard_data.py`; port the keyword list |
| Manual events | New table `forecast_overrides` (id, accountId, date, amount, label, kind: 'skip' \| 'shift' \| 'override') | User edits propagate here |

### Forecast engine

`electron/integrations/finance-forecast.ts`:

```ts
export type ForecastEvent = {
  date: string                 // YYYY-MM-DD
  accountId: number
  amount: number               // negative = outflow
  label: string
  source: 'subscription' | 'income' | 'debt' | 'calendar' | 'override'
  confidence: 'high' | 'medium' | 'low'
}

export function projectCashflow(
  db: BetterSQLite3Database<typeof schema>,
  startingBalances: Record<number, number>,   // accountId → today's balance
  windowDays: number = 90,
  today: Date = new Date()
): {
  events: ForecastEvent[]
  trajectory: { date: string; accountId: number; balance: number }[]
}
```

Confidence rules: subscriptions with > 6 charges = high, 3–6 = medium,
< 3 = low; income from a single deposit ≥ 3 cycles = high; everything else = medium.

### IPC

- `finance:get-forecast` → `{ events, trajectory, lowDates }`
- `finance:set-forecast-override` → upsert `forecast_overrides` row
- `finance:delete-forecast-override` → remove

### UI

- Chart: `Recharts` (already a dep). Multi-line, one line per account, hover
  tooltips show event causing each step.
- Event list: collapsible weekly groups. Each event row has a popover with
  Skip / Shift / Override / Reset.
- Low-cash warning: amber banner top of tab if any account dips below threshold,
  links to first offending date.

### Schema additions

```ts
// electron/db/schema.ts (append)
export const forecastOverrides = sqliteTable('forecast_overrides', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').references(() => financeAccounts.id).notNull(),
  date: text('date').notNull(),                 // YYYY-MM-DD
  amount: real('amount'),                       // null = no amount change, set with kind='shift' or 'skip'
  label: text('label'),
  kind: text('kind').notNull(),                 // 'skip' | 'shift' | 'override'
  shiftToDate: text('shift_to_date'),           // populated when kind='shift'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})
```

Plus `paymentDayOfMonth` column on `financeAccounts`.

## Test coverage required

- `finance-forecast.test.ts`:
  - Trajectory math is correct for one account, one subscription
  - Multiple subscriptions on same day stack
  - Income events flip the trajectory upward
  - Override `kind: skip` removes the event
  - Override `kind: shift` moves it
  - Override `kind: override` replaces the amount
  - 90-day window is honored
  - Low-cash detection fires at the right date

## Out of scope

- Multi-currency. Everything is USD for now.
- Probabilistic forecasting (Monte Carlo over historical variance). Single-line projection only.
- Re-forecasting based on YTD pace (e.g. "groceries are running 15% hot, project that forward"). v2.

## Suggested driver

`integration-implementer` for the engine + IPC; `migration-author` for the
schema; `ui-polish` for the chart and event list.

Single PR, medium size (~500–700 LOC including tests).
