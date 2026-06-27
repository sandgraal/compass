# Finance

**Route:** `/finance` · **Sidebar:** Finance · **⌘K:** "Finance" / "Net Worth" / "Cash-flow forecast"

A complete local-first personal-finance command center: statement ingest, auto-categorization,
net-worth tracking, a 90-day cash-flow forecast, subscription auditing, budgets, and tax tagging.
Everything runs on your machine; raw transactions never leave it. Full design:
[`docs/finance.md`](https://github.com/sandgraal/compass/blob/main/docs/finance.md).

## The daily-driver loop (no manual entry)

1. **Drop a statement** — a `.csv`, `.xlsx`, or `.pdf` — into your watched folder
   (default `~/Documents/Money/`, configurable; 3 subfolder levels deep).
2. Compass detects the file and **ingests in place** (it does not move your source files):
   parse → categorize → dedupe → tag geography/purpose → tag for taxes → insert → run the CR ATM split.
3. The `profile/finances*.md` knowledge summaries regenerate.
4. The Finance UI reloads automatically.

Built-in CSV parsers cover **Chase, Amex, Capital One, Discover, Bank of America, USAA, Rocket
Money, and a generic format**; PDF extractors cover **USAA, AMEX, and generic** statements. You
can also link accounts via **[SimpleFIN or Plaid](#bank-sync-simplefin--plaid)** to skip the file
ritual entirely.

## The tabs

The page has seven tabs along the top:

### Overview
Your financial snapshot: total debt and weighted APR, this month's income vs. expense and savings
rate, budget target vs. actual, Costa Rica capex, annualized active-subscription cost, and a tax
summary. A toggle lets you **exclude property** from the figures.

### Net Worth
Assets, liabilities, and net worth, plus **30 / 90 / 365-day deltas** and a trajectory chart. Net
worth is built from nightly per-account **balance snapshots** (captured automatically at 00:05
local time, idempotent within a day). Balances are *inferred* from the last snapshot plus the sum
of transactions since; "manual asset" accounts (e.g. property, collectibles) are set by hand.

### Forecast
A **90-day daily cash-flow projection** combining four event streams:

| Stream | Source | Confidence |
|---|---|---|
| Subscriptions | recurring-charge detection | high ≥6 charges / medium 3–5 / low <3 |
| Recurring income | biweekly/weekly/monthly payroll detection | same scale |
| Debt minimums | each account's `minPayment` on its payment day | high |
| Calendar bills | calendar events matching rent/mortgage/utilities/tax/etc. | low (amount unknown) |

It surfaces a **cash low warning** when the projected balance dips below threshold. You can edit
the projected stream per event — **skip / shift the date / override the amount** (the *Override
action* / *New date* controls) — and each edit is an atomic upsert keyed on
`(account, date, label)`. Debt minimums are modeled as cash outflows (the question is "will my cash
be short?"); the matching liability decrease shows up under Net Worth.

### Transactions
The transaction ledger: date, description, category, amount. Edit a transaction's category, delete
it, or set its **tax tag**. Negative amounts are expenses, positive are income (each parser
normalizes its source's convention).

### Accounts
Manage accounts: name, type (bank / credit / investment / debt), balance, and credit limit. Debts
are accounts flagged `isDebt`; you can set a **payment day of month** (feeds the forecast) and a
net-worth **asset class** bucket.

### Rules
Auto-categorization rules: priority, pattern, category, subcategory. Precedence is: your rules
(longest matching substring wins) → the CR ATM-ID regex → a Rocket-Money category fallback →
`Uncategorized`. There's a **Re-apply to all** action to re-run rules across existing transactions.

### CR & Subs
Two reports in one tab:
- **Geography of spend** — spend by country (CR / US / Spain / Colombia / Panama / Other) with txn
  counts and share, plus a **Costa Rica purpose breakdown** (capex / operating / household / travel / other).
- **Subscriptions** — detected recurring charges (merchant, account, cadence, per-charge, annualized,
  last seen) and **possible duplicates**, so you can find zombie subscriptions and price hikes.

## Categorization, geography & tax tagging

- **Geo / purpose** (`geo`, `purpose`) are indexed columns set at ingest, defaulting to `US`;
  `purpose` is only set on CR transactions.
- **Tax tags** classify rows into Schedule C income/expense, capex-airbnb, charitable, medical,
  investment, or none — at ingest, with the `(taxYear, taxTag)` pair indexed for year-end
  aggregation. Manual overrides are **sticky** (`taxTagSource='user'`) so re-tagging never clobbers
  your picks. You can export a **tax pack** (`finance:export-tax-pack`).

## Bank sync (SimpleFIN + Plaid)

Instead of dropping files, link a bank directly. Bank sync is the source of truth (the legacy Excel
pipeline was retired 2026-05-21).

- **SimpleFIN Bridge (recommended)** — *user-as-aggregator.* Sign up for SimpleFIN Bridge (~$15/yr), link
  your own banks (16k+ institutions incl. **Amex**), and paste a one-time setup token. Only an encrypted
  **Access URL** leaves the machine (`.vault/simplefin.enc`); the pull is date-windowed and credit-positive
  (no sign flip). A conservative classifier lands cards/loans on the liability side at first link.
- **Plaid (advanced / BYO-keys)** — bring your own `client_id` + secret (entered on the Integrations card).
  Link runs in a sandboxed child window; `/transactions/sync` cursor for incremental pulls. **Access tokens
  are encrypted in `.vault/plaid.enc` — never in the database.** Accounts link back via `plaidItemId` /
  `plaidAccountId` / `mask`.

Both dedupe through the same `finance_transactions.hash` constraint as a manual CSV drop, write
`sync_events`, and run on a daily 06:00 cron. Empty state when nothing's linked: *"No banks connected yet."*

## Where the data lives

| What | Where | Encrypted |
|---|---|---|
| Transactions, accounts, rules, budgets, snapshots, forecast overrides | `.data/compass.db` | No |
| Account credentials, raw account numbers, bank-sync tokens | `.vault/financial.enc`, `.vault/simplefin.enc`, `.vault/plaid.enc` | **Yes** (AES-256-GCM) |
| Markdown summaries (no PII) | `knowledge-base/profile/finances*.md` | No |
| Source statements | read in place in the watched folder (not moved) | No |

> **Privacy note:** Claude/MCP and Ask Compass only ever see finance as **aggregates/summaries** —
> never raw transaction rows. See [Claude & MCP](Claude-and-MCP) and [Security & Privacy](Security-and-Privacy).

## Related

- [Settings](Settings) — set the watched folder and sync behavior.
- [Integrations](Integrations) — Plaid connection lives alongside Google/GitHub.
