# Finance Module

Local-first personal finance, integrated as a peer of Calendar / Gmail / GitHub.
Owns ingest, categorization, debt tracking, net worth, forecast, tax tagging, and
the dashboard for the user's financial life. It **replaced** the legacy Excel
pipeline, which was retired early on **2026-05-21** once bank sync became the source
of truth (see [`finance/legacy-cutover.md`](finance/legacy-cutover.md)).

> **Bank sync:** the recommended path is **SimpleFIN Bridge** (user-as-aggregator,
> 16k+ institutions incl. Amex); **Plaid** is retained as an advanced /
> bring-your-own-keys option. CSV/PDF drop + watched-folder ingest remain the
> fallback for institutions neither reaches (e.g. CR Banco Popular). See § Bank sync.

> **Forward roadmap:** the next finance work is the cross-border / retirement layer —
> see [`strategic-review-2026-06.md`](strategic-review-2026-06.md) +
> [`implementation_plan.md`](implementation_plan.md) § Phase 11.

## Surfaces

| Layer | File | Purpose |
|---|---|---|
| Schema | `electron/db/schema.ts` (finance section) | `financeAccounts` (debts via `isDebt=true`, net-worth bucket via `assetClass`, debt pay day via `paymentDayOfMonth`, optional Plaid/SimpleFIN linkage via `plaidItemId`+`plaidAccountId`+`mask`), `financeTransactions` (with indexed `geo`, `purpose`, `taxTag`, `taxYear`), `categorizationRules`, `budgetRules`, `financeBalanceSnapshots`, `forecastOverrides`, `plaidItems`, `simplefinConnections` |
| Ingest | `electron/integrations/finance.ts` | CSV parsers (Chase, Amex, Cap One, Discover, BoA, USAA, Rocket Money, generic), categorizer, dedupe |
| PDF | `electron/integrations/finance-pdf.ts` | Statement extractors (USAA, AMEX, generic) |
| Watcher | `electron/integrations/finance-watcher.ts` | Chokidar watch on `~/Documents/Money/` (configurable), 3-level subfolder depth, `.csv` + `.xlsx` + `.pdf` allowlist |
| Bank sync | `electron/integrations/simplefin/*` · `electron/integrations/plaid/*` | **SimpleFIN** (recommended; setup-token → encrypted Access URL, date-windowed pull, `classify.ts` card/loan detection, no sign-flip) and **Plaid** (advanced; Link child-window + `transactions/sync` cursor loop). Tokens encrypted in `.vault/{simplefin,plaid}.enc`; daily 06:00 cron; both normalize into the shared `RawTxn` pipeline. |
| Geo / purpose | `electron/integrations/finance-geo.ts` | Classifies CR / US / SPAIN / etc. + capex/operating/etc. for CR rows. Sets indexed columns at ingest. |
| Tax tagging | `electron/integrations/finance-tax.ts` | Schedule C / E / capex-airbnb / charitable / medical / investment / none. Auto-runs after geo; user overrides sticky via `taxTagSource='user'`. |
| Net-worth snapshots | `electron/integrations/finance-snapshot.ts` | Nightly per-account balance capture. Inferred from snapshot baseline + Σ(txns since); manual_asset accounts edited via `setAccountBalance`. |
| Cash-flow forecast | `electron/integrations/finance-forecast.ts` | 90-day projection: subscriptions + recurring income + debt minimums + calendar bills + user overrides. Day-aggregated to avoid within-day order artifacts; debt minimums route to a cash account. |
| ATM split | `electron/integrations/finance-atm-split.ts` | 70/30 CR ATM auto-split (Property/Construction vs personal cash) |
| Subscriptions | `electron/integrations/finance-subscriptions.ts` | Recurring detection, zombies, duplicates |
| Knowledge | `electron/knowledge/finance-extractor.ts` | Writes `profile/finances.md`, `profile/finances-debt.md`, `profile/finances-monthly.md` |
| IPC | `electron/ipc/finance.ts` | 35+ handlers — see `electron/preload.ts` for the full surface |
| UI | `src/pages/Finance.tsx` | Overview / Net Worth / Forecast / Transactions / Accounts / Rules / CR & Subs tabs — all shipped (incl. the YTD Tax summary card + tax-pack export button) |

## Sign convention

- Negative `amount` = expense, positive = income.
- Each parser flips its source's convention if needed (Amex / Discover / Rocket Money export expenses as positive numbers).
- Hash dedupe key: `sha1(date|amount|desc|account)` — first 16 chars.

## Categorization precedence

1. User/seed `categorizationRules` (first substring match wins, longest pattern preferred).
2. **CR ATM-id regex** `/\b020\d{4,6}\b/` → `Cash / ATM withdrawal`.
3. **Rocket Money fallback**: if `notes` carries an `rm:CATEGORY` token, map via `RM_CATEGORY_MAP`.
4. Default: `Uncategorized`.

## Geo / purpose tagging

First-class indexed columns on `financeTransactions` (promoted from `notes`
tokens in Phase 4.2):

- `geo` ∈ `CR | US | SPAIN | COLOMBIA | PANAMA | OTHER` — `US` default. Indexed.
- `purpose` ∈ `capex | operating | household | travel | other` — only set on
  CR transactions; nullable. Indexed via the `(geo, purpose)` compound index.

`tagGeoAndPurpose()` in `finance-geo.ts` writes both fields directly at ingest;
re-running on the same batch is idempotent. The `notes` column still carries
the upstream `rm:CATEGORY` token from Rocket Money imports — that's input data
for the categorizer, not output for queries.

## Tax tagging (Phase 4.3)

`taxTag` column on `financeTransactions` with `(taxYear, taxTag)` index.
Classified at ingest by `finance-tax.ts`; override IPC marks
`taxTagSource='user'` so re-tag passes never overwrite manual picks.

Rule order (first match wins):
1. **CR + capex** → `tax:capex-airbnb` (depreciable Airbnb investment).
   Wins over Schedule C because hardware purchased on the business card for
   the CR build is real-estate capex, not a deductible expense.
2. **Enndustrious account activity** → `tax:schedule-c-income` (deposit) or
   `tax:schedule-c-expense` (withdrawal). Internal transfers stay neutral.
3. **Category mapping** — Charity/Gifts → `tax:charitable`; Investment →
   `tax:investment`; Health (negative + non-reimbursement subcategory) →
   `tax:medical`.
4. **Default**: `tax:none`.

Add new business accounts to `SCHEDULE_C_ACCOUNT_HINTS` in `finance-tax.ts`.

## Net-worth snapshots (Phase 4.4)

Per-(account, day) balance row in `finance_balance_snapshots`. Cron at 00:05
local time captures one snapshot per non-`manual_asset` account, **idempotent
within a calendar day**. `manual_asset` accounts (CR property, collectibles)
only capture when the user sets a non-zero balance via
`finance:set-account-balance`.

Inference math: `previous_snapshot.balance + Σ(txns since previous_snapshot
date, up to today)`. **Sign convention for debts**: txn `amount` follows the
codebase rule (negative = charge / expense), but stored debt balances are
positive amounts owed — so `inferBalance` flips the txn-sum sign for
`isDebt=true` accounts. A $50 charge raises owed by 50; a $200 payment
reduces it by 200.

`getNetWorthSnapshot()` returns assets / liabilities / net + 30/90/365-day
deltas; `getNetWorthTrajectory({ sinceMs, untilMs })` returns every snapshot
in window for chart rendering.

## Cash-flow forecast (Phase 4.5)

`buildForecast()` produces a 90-day per-account daily trajectory from four
event streams:

| Stream | Source | Confidence |
|---|---|---|
| Subscriptions | `auditSubscriptions(db).active` (Phase 4.0) | high if ≥6 charges, medium if 3-5, low if <3 |
| Recurring income | `detectRecurringIncome(sqlite)` — biweekly / weekly / monthly payroll detection. Excludes debt accounts (positives there are payments, not income). | same scale |
| Debt minimums | `financeAccounts.minPayment` on `paymentDayOfMonth` | high |
| Calendar bills | `calendar_events` matching `rent / mortgage / utilities / tax / hoa / lease / insurance / payment due` | low (amount unknown) |

**Debt minimums route to the default cash account, NOT the debt account** —
the forecast's job is "will my cash be short?", and the corresponding
liability decrease is tracked by the Net Worth view.

Same-day events for the same account are aggregated before walking, so a
$100 outflow + $200 inflow on the same day produces one trajectory point at
day-end (+$100), not two intermediate points whose order could spuriously
trigger or mask the low-cash threshold.

Override match key is `(accountId, date, label)` — UNIQUE in the DB so
`set-forecast-override` is an atomic upsert via `onConflictDoUpdate`. Two
events on the same account+day can be edited independently.

## CR ATM split

CR ATM withdrawals (Banco Popular, Scotiabank, the `020NNNNNNN` ATM-ID prefix)
are post-processed after each ingest:

- Original row → 70 % with category `Property / Construction — labor (est)`.
- New sibling row → 30 % with category `Cash / Personal — split sibling`.
- Marker `70% project split` / `30% personal split` in `notes` makes the split
  idempotent. To override per-row, edit the category in the UI; the marker
  prevents re-splitting.

## Watch flow (the daily-driver loop)

1. User drops a CSV / PDF into `~/Documents/Money/` (or whichever folder is set
   via `finance:set-watch-folder`).
2. `finance-watcher.ts` (chokidar) detects the file, calls
   `ingestWatchedFolderNow()`.
3. `ingestFinanceFiles()` parses → categorizes → dedupes → `tagGeoAndPurpose()`
   → `tagTax()` → inserts (read-in-place; source files are not moved) → runs
   `applyAtmSplit()` if any rows were added. Handles `.csv` + `.xlsx` + `.pdf`.
   (The sibling `ingestCsvFolder()` is the older inbox/drain path: top-level
   `.csv` only, with archive-on-success — not what the watcher uses.)
4. `finance-extractor.ts` regenerates the markdown summary in
   `knowledge-base/profile/`.
5. UI reloads via `finance-watcher:ingest-complete` event.

## Bank sync (SimpleFIN + Plaid)

Two paths pull transactions automatically; the CSV/PDF watcher stays the fallback for what neither reaches.

- **SimpleFIN Bridge (recommended).** *User-as-aggregator*: the user signs up for SimpleFIN Bridge
  (~$15/yr), links their own banks (16k+ institutions incl. **Amex** via MX), and pastes a one-time setup
  token. Only an encrypted **Access URL** leaves the machine (`.vault/simplefin.enc`); the pull is
  date-windowed (no cursor) and **not** sign-flipped (SimpleFIN is already credit-positive). `classify.ts`
  lands a card/loan on the liability side at first link. No developer quota, no OAuth widget — the right
  shape for a distributed app. Files:
  `electron/integrations/simplefin/{config,vault,client,classify,match,normalize,sync}.ts`.
- **Plaid (advanced / BYO-keys).** *Developer-as-aggregator*: needs your own `client_id` + secret (entered
  in-app on the Integrations card). Link runs in a sandboxed child `BrowserWindow` (CSP-pinned to
  `*.plaid.com`); `transactions/sync` cursor loop; encrypted tokens in `.vault/plaid.enc`. Files:
  `electron/integrations/plaid/{config,client,link,normalize,cursor,sync,errors}.ts`.

Both write `sync_events` + `integrations.lastSyncedAt`, run on a daily 06:00 cron, and dedupe through the
same `finance_transactions.hash` UNIQUE constraint as a manual CSV drop (so a CSV→bank-sync migration
never double-counts).

## Where the data lives

| What | Where | Encrypted |
|---|---|---|
| Transactions, accounts, categorization rules, budget rules | SQLite at `.data/compass.db` | No |
| Account credentials, raw account numbers | `.vault/financial.enc` | Yes (AES-256-GCM via `safeStorage`) |
| Markdown summaries (no PII) | `knowledge-base/profile/finances*.md` | No |
| Source CSVs / PDFs after ingestion | Watched-folder mode reads in place (no auto-move). Inbox/drain ingest mode archives to `~/Documents/Money/archive/`. | No |

## Legacy Excel pipeline (retired 2026-05-21)

The original implementation lived in a user-configured legacy finance project
directory and ran in parallel as a reconciliation backstop until **2026-05-21**,
when bank sync became the source of truth and the Excel project was archived —
ahead of the originally planned 2026-06-10 cutover. Compass is now the only active
finance system. See [`finance/legacy-cutover.md`](finance/legacy-cutover.md) for the
migration playbook.

The one-shot importer at `scripts/import-from-excel.ts` (reads
`master_ledger.compass.json` / `debt_tracker.compass.json`) remains idempotent and
safe to re-run for historical backfill.

## Forward roadmap

See [`docs/finance/`](finance/) for individual feature plans. Status as of
the latest merge:

- ✅ [`db-migrate-fix.md`](finance/db-migrate-fix.md) — `npm run db:migrate` works
- ✅ [`geo-purpose-schema-promotion.md`](finance/geo-purpose-schema-promotion.md) — geo/purpose are indexed columns
- ✅ [`tax-tagging.md`](finance/tax-tagging.md) — Schedule C / E / capex tags + YTD Tax card + tax-pack export
- ✅ [`net-worth.md`](finance/net-worth.md) — snapshot backend + Net Worth tab
- ✅ [`cash-flow-forecast.md`](finance/cash-flow-forecast.md) — 90-day forecast + Forecast tab
- ✅ [`plaid-integration.md`](finance/plaid-integration.md) — Plaid bank-linking (6 PRs, shipped; advanced / BYO-keys)
- ✅ **SimpleFIN Bridge** — recommended user-as-aggregator bank/card sync (shipped 2026-06-14; `electron/integrations/simplefin/*`)
- ✅ [`legacy-cutover.md`](finance/legacy-cutover.md) — Excel pipeline retired early (2026-05-21)

**Next (proposed — Phase 11 "Life Planning & Cross-Border"):** multi-currency (USD/CRC + FX),
foreign-account & expat-tax (FBAR/FATCA), CR property/Airbnb P&L + depreciation, and a long-horizon
retirement projection. See [`strategic-review-2026-06.md`](strategic-review-2026-06.md) +
[`implementation_plan.md`](implementation_plan.md) § Phase 11.

The implementation plan's
[Phase 4 — Finance forward](./implementation_plan.md#phase-4--finance-forward-roadmap)
section tracks which features are claimed / in-flight / done.
