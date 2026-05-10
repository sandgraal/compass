---
"compass": minor
---

Finance: absorb the standalone Excel ledger pipeline into Compass.

**Ingest**
- New Rocket Money parser detects the 15-column rocketmoney.com export by
  header signature, flips RM's expense-positive sign convention, normalizes
  user-defined account names (e.g. `Chris Checking` → `USAA Checking`,
  `Platinum Card®` → `Amex Platinum`), preserves RM's auto-category as an
  `rm:CATEGORY` token in notes, and skips rows the user already flagged
  "Ignored From: everything".
- `categorize()` gains two smart fallbacks after rule miss: a regex for the
  Costa Rica `020NNNNNNN` ATM-ID format, and an `RM_CATEGORY_MAP` that
  translates RM's own taxonomy when the txn carries an `rm:` token in notes.

**Geography & purpose**
- New `electron/integrations/finance-geo.ts` tags every ingested transaction
  with `geo:CR | purpose:capex` style tokens in the existing `notes` column
  (no schema migration). `classifyGeo` covers CR / US / Spain / Colombia /
  Panama; `classifyPurpose` distinguishes Airbnb capex from operating /
  household / travel for CR transactions. Idempotent on re-ingest.

**ATM 70/30 auto-split**
- New `electron/integrations/finance-atm-split.ts` post-processes CR ATM
  withdrawals: 70% reclassified to Property/Construction — labor (est), 30%
  inserted as a sibling row tagged Cash/Personal — split sibling. Marker in
  notes prevents re-splitting.

**Subscription audit**
- New `electron/integrations/finance-subscriptions.ts` and
  `finance:get-subscriptions` IPC handler detect recurring charges (≥3
  occurrences, regular cadence) in subscription-like categories. Emits
  active / zombie / expired / duplicates with annualized cost.

**Excel import**
- New `scripts/import-from-excel.ts` migrates the existing
  `master_ledger.xlsx` + `categories.json` + `debt_tracker.xlsx` into the
  Compass DB in one shot. Idempotent — uses existing hash for dedupe.

**UI**
- New "CR & Subs" tab on the Finance page: geography table, CR purpose
  breakdown, active subscriptions, zombies, duplicates.
- New tiles on Overview: CR build (capex, 12mo) and monthly subscription
  run-rate.
- New "Hide Property" toggle on the budget summary — Costa Rica
  construction is 30-40% of total spend and was distorting the category
  view; toggle removes it so household spend is legible.

**Plumbing**
- `finance:get-subscriptions` and `finance:get-geo-summary` IPC handlers
  exposed on `window.api.finance`, with full type defs in
  `src/types/electron.d.ts`.
