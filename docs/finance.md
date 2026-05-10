# Finance Module

Local-first personal finance, integrated as a peer of Calendar / Gmail / GitHub.
Owns ingest, categorization, debt tracking, budget, and dashboard for the user's
financial life. Replaces the legacy Excel pipeline at
`~/Documents/Claude/Projects/Getting on top of finances/` (in transition through
2026-06-10 — see [`finance/legacy-cutover.md`](finance/legacy-cutover.md)).

## Surfaces

| Layer | File | Purpose |
|---|---|---|
| Schema | `electron/db/schema.ts` (finance section) | `financeAccounts` (debts modeled via `isDebt=true`), `financeTransactions`, `categorizationRules`, `budgetRules` |
| Ingest | `electron/integrations/finance.ts` | CSV parsers (Chase, Amex, Cap One, Discover, BoA, USAA, Rocket Money, generic), categorizer, dedupe |
| PDF | `electron/integrations/finance-pdf.ts` | Statement extractors (USAA, AMEX, generic) |
| Watcher | `electron/integrations/finance-watcher.ts` | Chokidar watch on `~/Documents/Money/` (configurable), 3-level subfolder depth, `.csv` + `.pdf` allowlist |
| Geo | `electron/integrations/finance-geo.ts` | Tags every txn with `geo:CR \| purpose:capex`-style tokens in `notes` |
| ATM split | `electron/integrations/finance-atm-split.ts` | 70/30 CR ATM auto-split (Property/Construction vs personal cash) |
| Subscriptions | `electron/integrations/finance-subscriptions.ts` | Recurring detection, zombies, duplicates |
| Knowledge | `electron/knowledge/finance-extractor.ts` | Writes `profile/finances.md`, `profile/finances-debt.md`, `profile/finances-monthly.md` |
| IPC | `electron/ipc/finance.ts` | 24+ handlers — see `electron/preload.ts` for the full surface |
| UI | `src/pages/Finance.tsx` | Overview / Transactions / Accounts / Rules / CR & Subs tabs |

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

Stored in the existing `notes` column as pipe-delimited tokens:
`rm:Groceries | geo:CR | purpose:household`.

- `geo` ∈ `CR | US | SPAIN | COLOMBIA | PANAMA` (US is default for unknown).
- `purpose` ∈ `capex | operating | household | travel | other` — only set on CR transactions.
- Tag-aware queries use `parseNotesTags()` from `finance-geo.ts`.
- Idempotent: re-running `tagGeoAndPurpose()` replaces existing tags rather than duplicating.

The `notes`-column approach was chosen to ship the Rocket Money import without a
schema migration. Promotion to indexed columns is planned —
see [`finance/geo-purpose-schema-promotion.md`](finance/geo-purpose-schema-promotion.md).

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
3. `ingestCsvFolder()` parses → categorizes → dedupes → tags geo/purpose →
   inserts → archives the file → runs `applyAtmSplit()` if any rows were added.
4. `finance-extractor.ts` regenerates the markdown summary in
   `knowledge-base/profile/`.
5. UI reloads via `finance-watcher:ingest-complete` event.

## Where the data lives

| What | Where | Encrypted |
|---|---|---|
| Transactions, accounts, categorization rules, budget rules | SQLite at `.data/compass.db` | No |
| Account credentials, raw account numbers | `.vault/financial.enc` | Yes (AES-256-GCM via `safeStorage`) |
| Markdown summaries (no PII) | `knowledge-base/profile/finances*.md` | No |
| Source CSVs / PDFs after ingestion | `~/Documents/Money/archive/` (auto-moved) | No |

## Legacy Excel pipeline (transition)

The original implementation lives at
`~/Documents/Claude/Projects/Getting on top of finances/` and continues to run
in parallel through **2026-06-10** as a reconciliation backstop. After that the
Excel project is archived and Compass is the only active finance system. See
[`finance/legacy-cutover.md`](finance/legacy-cutover.md) for the migration
playbook.

The one-shot importer at `scripts/import-from-excel.ts` reads JSON dumps the
legacy project produces (`master_ledger.compass.json`,
`debt_tracker.compass.json`). It's idempotent — safe to re-run.

## Forward roadmap

See [`docs/finance/`](finance/) for individual feature plans (each one sized to
land as one PR):

- [`cash-flow-forecast.md`](finance/cash-flow-forecast.md) — 90-day projection page
- [`net-worth.md`](finance/net-worth.md) — asset-side tracking, true net-worth view
- [`tax-tagging.md`](finance/tax-tagging.md) — Schedule C / E / capex tags
- [`plaid-integration.md`](finance/plaid-integration.md) — kill the manual CSV ritual
- [`geo-purpose-schema-promotion.md`](finance/geo-purpose-schema-promotion.md) — promote tags to indexed columns
- [`db-migrate-fix.md`](finance/db-migrate-fix.md) — restore `npm run db:migrate`
- [`dashboard-snapshot-ipc.md`](finance/dashboard-snapshot-ipc.md) — fold `dashboard_data.py` into an IPC + MCP tool
- [`knowledge-base-alignment.md`](finance/knowledge-base-alignment.md) — Friday-review markdown lands in Compass KB
- [`legacy-cutover.md`](finance/legacy-cutover.md) — Excel pipeline retirement

The implementation plan's
[Phase 4 — Finance forward](./implementation_plan.md#phase-4--finance-forward-roadmap)
section tracks which features are claimed / in-flight / done.
