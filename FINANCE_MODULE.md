# Finance Module — Scaffold

This is a scaffold for a first-class finance module inside Compass.
Files dropped by the cowork session that built the external finance
system at `~/Documents/Claude/Projects/Getting on top of finances/`.

The external system is the source of truth for now (CSV-driven, owned by
Python scripts). It already writes finance markdown into Compass's
`knowledge-base/profile/finances*.md`. These scaffolds let you fold the
ingestion + queries into Compass itself when you're ready, so finance
becomes a peer of Calendar / Gmail / GitHub rather than a sidecar.

## What's here

- `electron/db/schema.finance.ts` — drizzle schema additions
  (`financeTransactions`, `financeAccounts`, `financeDebts`, `financeBudgetLines`,
  `financeCategoryRules`). Merge into `electron/db/schema.ts` when wiring up.
- `electron/integrations/finance.ts` — CSV ingestion port of the Python
  `08_scripts/ingest.py`. Detects Chase/Amex/Capital One/BoA/Citi/Discover
  formats, normalizes, dedupes via SHA-1 hash, applies category rules.
- `electron/knowledge/finance-extractor.ts` — markdown writers in the same
  shape as `electron/knowledge/extractor.ts`. Writes
  `profile/finances.md`, `profile/finances-debt.md`, `profile/finances-monthly.md`.
- `electron/ipc/finance.ts` — IPC handlers for the React UI:
  `finance:ingest-folder`, `finance:get-transactions`, `finance:get-debt-summary`,
  `finance:get-budget-status`, `finance:set-budget`.
- `src/pages/Finance.tsx` — page stub that mirrors `Weekly.tsx`'s layout.

## How to wire in

1. **Schema**: open `electron/db/schema.ts`, paste in the table definitions
   from `electron/db/schema.finance.ts`. Run `npm run db:generate` to
   create a migration, then `npm run db:migrate`.
2. **Main**: in `electron/main.ts`, add `registerFinanceHandlers(ipcMain)`
   after the other `register*Handlers` calls. Import from `./ipc/finance`.
3. **Cron**: in `electron/cron.ts`, add a watcher for the inbox folder
   (chokidar is already a dep) — when a CSV lands, call
   `ingestCsvFolder(getDb(), inboxDir)`. Or register a daily cron
   alongside the 15-min Google/GitHub one.
4. **Knowledge**: nothing to do — `finance-extractor.ts` follows the same
   `updateKnowledgeFile()` pattern, so finance markdown lands in
   `knowledge-base/profile/` automatically on each ingest.
5. **UI**: add `<Route path="/finance" element={<Finance />} />` in
   `src/App.tsx`, plus a sidebar entry in your layout component.
6. **Vault**: account credentials (numbers, login info) belong in the
   Vault under the existing `financial` category. The finance module
   only stores account *labels* in `financeAccounts` (e.g. "Chase Sapphire").
7. **Integrations page**: add a "Bank CSV" tile that opens the inbox folder
   in Finder so the user can drop CSVs in. (Plaid in v2 — `electron/integrations/plaid.ts`.)

## Where the data lives

| What | Where | Encrypted? |
|---|---|---|
| Transactions, debts, budget lines | SQLite at `.data/compass.db` | No |
| Account credentials, raw account numbers | `.vault/financial.enc` | Yes (AES-256-GCM) |
| Markdown summaries (no PII) | `knowledge-base/profile/finances*.md` | No |
| Source CSVs after ingestion | `~/Documents/Compass/finance/archive/` (suggested) | No |

## What stays in the external project

The Excel workbooks (`master_ledger.xlsx`, `debt_tracker.xlsx`,
`budget.xlsx`) stay where they are — they're a useful interactive layer
that's friendlier than a SQL CLI for poking at numbers, building
scenarios, and showing in spreadsheets. The Python ingest script writes
to both: the workbooks AND (via `compass_writer.py`) the Compass
knowledge base.

When you finish wiring this module, you can either keep both layers in
sync (Excel as the analyst view, Compass as the daily-driver app) or
deprecate Excel and have the Compass UI hold everything. The IPC
handlers below were designed so the Excel workbooks can be regenerated
from the SQLite tables if you go that route.
