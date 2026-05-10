# Tax tagging

## Goal

Tag every transaction with its tax disposition so year-end prep is a query
rather than a re-categorization marathon. CR Airbnb spend is depreciable
property; Enndustrious checking activity is Schedule C business; the eventual
Airbnb rental income is Schedule E.

## Why now

The CR build now has substantial capex activity with no tax-coded distinction
between consumption and investment. By the time it's a Q4 problem, years of
transactions need re-classifying. Tagging at ingest is cheap; retro-tagging an
entire backlog next April is not.

## Acceptance criteria

- [ ] New `taxTag` column on `financeTransactions`, indexed.
- [ ] Tax tagger module that infers `taxTag` from category + account + geo at
      ingest time, with explicit override support.
- [ ] Backfill script that runs the tagger over the full ledger, idempotent.
- [ ] UI: tax tag visible in Transactions tab as a badge; click-to-override
      opens a dropdown.
- [ ] New IPC handler `finance:get-tax-summary?year=2026` returns a per-tag
      total suitable for a year-end report.
- [ ] Unit-tested rule set covering at least: capex (CR Property), Schedule C
      (Enndustrious), Schedule E (rental income, when active), home-office
      portion of household, charitable donations, medical, personal.

## Approach

### Tag taxonomy

```
tax:capex-airbnb        — CR build asset (depreciable over 27.5y residential)
tax:schedule-c-income   — business income (Enndustrious checking deposits)
tax:schedule-c-expense  — business expenses
tax:schedule-e-income   — rental income (Airbnb when active)
tax:schedule-e-expense  — rental operating expense
tax:charitable          — donations (UNICEF etc., already in 'Charity'/'Gifts')
tax:medical             — Health category, deductible portion
tax:home-office         — % of CR/US housing if applicable
tax:personal            — explicit "this is consumption, not deductible"
tax:investment          — retirement contributions, brokerage transfers
tax:none                — default; doesn't impact taxes (cash transfers,
                          credit-card payments between own accounts, etc.)
```

### Schema

```ts
// electron/db/schema.ts (modify financeTransactions)
taxTag: text('tax_tag').notNull().default('tax:none'),
taxTagSource: text('tax_tag_source').notNull().default('auto'),  // 'auto' | 'user'
taxYear: integer('tax_year'),  // derived from date.year, indexed
```

Index: `(taxTag, taxYear)` for the year-end queries.

### Tagger

`electron/integrations/finance-tax.ts`:

```ts
export type TaxTag =
  | 'tax:capex-airbnb' | 'tax:schedule-c-income' | 'tax:schedule-c-expense'
  | 'tax:schedule-e-income' | 'tax:schedule-e-expense' | 'tax:charitable'
  | 'tax:medical' | 'tax:home-office' | 'tax:personal' | 'tax:investment'
  | 'tax:none'

export function classifyTax(txn: {
  amount: number
  account: string
  category: string
  subcategory: string | null
  notes: string | null
}, geo: Geo, purpose: Purpose): TaxTag
```

Rule order (first match wins):

1. User override (`taxTagSource === 'user'`) — never overwrite.
2. Account-based: any deposit into Enndustrious checking → `schedule-c-income`.
3. Geo+purpose: `geo:CR + purpose:capex` → `capex-airbnb`.
4. Category-based: `Charity`, `Gifts`, `Health` (with rules), `Subscriptions`
   (none — personal default), etc.
5. Default: `tax:none`.

### Hook into pipeline

In `ingestCsvFolder`, after `tagGeoAndPurpose`, run `tagTax(txns)` which sets
`taxTag` + `taxYear` on each. Idempotent on re-ingest because the categorize
fn is also idempotent.

### Backfill

`scripts/backfill-tax-tags.ts`:
- Read all `financeTransactions`
- Re-run `classifyTax` against each
- Update only rows where `taxTagSource === 'auto'`
- Print before/after distribution

### UI

- Transactions tab: small badge after the category pill, color-coded by tax
  tag. Click → dropdown to override.
- New "Tax" panel on Overview (or a separate tab if it grows): YTD totals per
  tag. Live link to a `finance:get-tax-summary` call.

### IPC

- `finance:get-tax-summary?year=YYYY` → `{ [taxTag]: { count, total } }`
- `finance:set-transaction-tax-tag` → set `taxTag`, mark `taxTagSource='user'`

## Test coverage required

- `finance-tax.test.ts`:
  - User override sticks across re-tag passes
  - Enndustrious deposit → schedule-c-income
  - CR Property/Construction → capex-airbnb
  - Charity → charitable
  - Default → tax:none
  - Backfill marks only `auto`-sourced rows
  - Year-end summary aggregates correctly

## Out of scope

- Generating actual Schedule C / E / D forms. Compass tags; humans (or
  TurboTax) file.
- Mileage / per-diem deductions. Add later if needed.
- Multi-state tax allocation (FL has no state income tax; CR is a separate
  filing concern handled by the user's accountant).

## Suggested driver

`migration-author` for the schema column; `integration-implementer` for
tagger + backfill; `ui-polish` for badges + override dropdown.

Single medium PR (~400–500 LOC) since the tag taxonomy is small and the rules
are local.
