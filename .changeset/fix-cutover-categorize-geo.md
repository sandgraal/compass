---
"compass": patch
---

Fix two cutover-blocking finance bugs found while preparing the 2026-06-10 legacy retirement reconciliation:

1. **Categorize was skipped when the user had zero rules.** `electron/integrations/finance.ts` gated `categorize(parsed, rules)` behind `rules.length > 0`, but the smart fallbacks (CR ATM ID regex + Rocket Money `rm:*` mapping) live INSIDE `categorize()`. Users who never set up custom rules saw 100% of Rocket Money rows stay `Uncategorized` even when the RM auto-category was a known mapping. The same gate existed on the in-place ingest path (`ingestFinanceFile`). Both now always call `categorize()`.

2. **Geo / purpose column drift.** Migration 0004 backfilled `geo` / `purpose` columns from the pre-Phase-4.2 `geo:X | purpose:X` tokens in `notes`, but the UPDATEs only ran once at migration time. Rows ingested afterward kept the schema default `geo='US'` when `classifyGeo(description)` couldn't infer the country (e.g. "FERRETERIA SANTA ROSJIMENEZ CA"), even though notes still carried `geo:CR`. New `backfillGeoFromNotes(db)` helper re-runs the migration's UPDATEs idempotently — wired into `ensureNewTables()` so every app launch closes the gap. The SQL uses `(col IS NULL OR col != ?)` so nullable `purpose` matches correctly under three-valued logic.

Closes a divergence of ~3,000 rows on a real ledger checked during the strategic review. After this lands, the legacy/Compass reconciliation should drop from "thousands of rows divergent" to clean.
