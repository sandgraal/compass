# Legacy Excel → Compass reconciliation log

Weekly reconciliation entries for the parallel-run window
**2026-05-10 → 2026-06-10** described in [`legacy-cutover.md`](legacy-cutover.md).
Goal of the table: surface any divergence between Compass's DB and the legacy
Python pipeline's `master_ledger.compass.json` BEFORE the cutover, so the
2026-06-10 archive is a clean snapshot rather than a frozen bug.

## How to add an entry each Sunday

The window for the **weekly** comparison is the FULL ledger (every row that
either side has). Per [`legacy-cutover.md`](legacy-cutover.md), each Sunday
checks "row counts, sums by category, sums by geo". The 12-month rolling
window is reserved for the [cutover-day final check](#cutover-day--2026-06-10).

1. In the legacy project:
   ```bash
   cd ~/Documents/Claude/Projects/Getting\ on\ top\ of\ finances/
   python3 08_scripts/dump_for_compass.py
   ```
   This writes `master_ledger.compass.json`, `debt_tracker.compass.json`,
   `subscription_audit.compass.json` next to the xlsx workbooks.

2. From Compass, query the same totals. SQL straight against the dev DB:
   ```bash
   sqlite3 ~/Library/Application\ Support/Compass/.data/compass.db <<'SQL'
   -- 2a. Row count + net / inflow / outflow over the FULL ledger.
   SELECT COUNT(*) AS row_count,
          ROUND(SUM(amount), 2) AS net_amount,
          ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) AS inflow,
          ROUND(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 2) AS outflow
     FROM finance_transactions;

   -- 2b. Sums by category (required by the cutover spec).
   SELECT COALESCE(category, 'Uncategorized') AS category,
          COUNT(*)                            AS rows,
          ROUND(SUM(amount), 2)               AS total
     FROM finance_transactions
    GROUP BY 1
    ORDER BY ABS(SUM(amount)) DESC;

   -- 2c. Sums by geo.
   SELECT geo, COUNT(*) AS rows, ROUND(SUM(amount), 2) AS total
     FROM finance_transactions
    GROUP BY geo
    ORDER BY ABS(SUM(amount)) DESC;
   SQL
   ```

3. Append a row to the table below. **Discrepancies > $1.00 trigger a halt** —
   file the bug, fix, re-import, re-run the totals before resuming. Use the
   "Categories Δ > $1" column to record EVERY category that diverges by more
   than a buck; an empty cell means full category parity.

## Weekly reconciliation

Each Sunday in the window, comparing the FULL ledger on both sides. The "Δ"
columns are `Compass − legacy`; any non-zero delta needs an explanation in
the **Notes** column. The **Categories Δ > $1** column lists every category
whose total differs by more than $1 (e.g. `Property: -42.10, Groceries: 8.50`);
empty cell = full category parity.

| Sunday      | Rows (legacy / Compass / Δ) | Net $ (legacy / Compass / Δ) | Geo CR $ (Δ) | Categories Δ > $1 | Subs (active / zombies, Δ) | Notes |
|-------------|------------------------------|------------------------------|--------------|--------------------|-----------------------------|-------|
| 2026-05-17  | _pending_                    | _pending_                    | _pending_    | _pending_          | _pending_                   | First reconciliation after Compass took over the daily-driver UI on 2026-05-10. |
| 2026-05-24  | _pending_                    | _pending_                    | _pending_    | _pending_          | _pending_                   | After `compass_writer.py` retirement (targeted 2026-05-20). Markdown summaries should now come only from Compass; legacy project no longer touches `knowledge-base/`. |
| 2026-05-31  | _pending_                    | _pending_                    | _pending_    | _pending_          | _pending_                   |       |
| 2026-06-07  | _pending_                    | _pending_                    | _pending_    | _pending_          | _pending_                   | Final reconciliation BEFORE cutover. Threshold for a clean cutover: zero discrepancies > $1.00 (see cutover section below for the 12-month window check). |

## Cutover day — 2026-06-10

Filled in by `docs-keeper` after the [cutover checklist](legacy-cutover.md#cutover-day-2026-06-10-checklist)
runs.

The checklist's "last 12 months" threshold is interpreted as
`date >= '2025-06-10'` (cutover_day − 12 months). Apply the SAME cutoff on
both sides so any discrepancy is a real mismatch, not a window shift.

```bash
# Compass side, 12-month rolling window.
sqlite3 ~/Library/Application\ Support/Compass/.data/compass.db <<'SQL'
SELECT COUNT(*), ROUND(SUM(amount), 2)
  FROM finance_transactions
 WHERE date >= '2025-06-10';

SELECT SUBSTR(date, 1, 7) AS month, COUNT(*), ROUND(SUM(amount), 2)
  FROM finance_transactions
 WHERE date >= '2025-06-10'
 GROUP BY 1 ORDER BY 1;

SELECT COALESCE(category, 'Uncategorized') AS category,
       COUNT(*), ROUND(SUM(amount), 2)
  FROM finance_transactions
 WHERE date >= '2025-06-10'
 GROUP BY 1 ORDER BY ABS(SUM(amount)) DESC;
SQL
```

On the legacy side, restrict `master_ledger.compass.json` to the same window
before comparing.

| Field                                          | Value     | Notes |
|------------------------------------------------|-----------|-------|
| Total row count, last 12 mo (Compass / legacy) | _pending_ | Window: `date >= '2025-06-10'`. Threshold: zero delta. |
| Net sum, last 12 mo (Compass / legacy)         | _pending_ | Same window. Threshold: zero discrepancies > $1.00. |
| Monthly sums match (12 months × 2 sides)       | _pending_ | List any month with delta > $1: `2025-09: -3.20`, etc. Empty = full parity. |
| Category sums match (last 12 mo)               | _pending_ | List any category with delta > $1: `Property: 12.40`, etc. Empty = full parity. |
| CR ATM splits — split-sibling = split-project? | _pending_ | Should be `true` (count parity). |
| Subscription audit parity                      | _pending_ | Same active list + zombies on both sides. |
| Friday weekly-review email sourcing Compass?   | _pending_ | Must be true for ≥ 2 weeks before cutover. |
| Plaid status                                   | _pending_ | live / punted (CSV watcher remains the daily-driver). |
| Legacy project archive path                    | _pending_ | Expected: `~/Documents/Claude/Archived/Getting on top of finances/`. |
| Scheduled tasks disabled                       | _pending_ | finance-weekly-review + finance-dashboard-refresh outside Compass. |

## Mismatch log

Append a dated entry below each time a reconciliation finds a delta that
needs investigation. Resolve before the next Sunday so the table above stays
clean.

> _No entries yet — populated during the window if divergences appear._
