# Legacy Excel → Compass reconciliation log

Weekly reconciliation entries for the parallel-run window
**2026-05-10 → 2026-06-10** described in [`legacy-cutover.md`](legacy-cutover.md).
Goal of the table: surface any divergence between Compass's DB and the legacy
Python pipeline's `master_ledger.compass.json` BEFORE the cutover, so the
2026-06-10 archive is a clean snapshot rather than a frozen bug.

## How to add an entry each Sunday

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
   SELECT COUNT(*) AS row_count,
          ROUND(SUM(amount), 2) AS net_amount,
          ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) AS inflow,
          ROUND(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 2) AS outflow
     FROM finance_transactions
    WHERE date >= '2025-01-01';
   SELECT geo, ROUND(SUM(amount), 2)
     FROM finance_transactions
    WHERE date >= '2025-01-01'
    GROUP BY geo;
   SQL
   ```

3. Append a row to the table below. **Discrepancies > $1.00 trigger a halt** —
   file the bug, fix, re-import, re-run the totals before resuming.

## Weekly reconciliation

Each Sunday in the window. The "Δ" columns are `Compass − legacy`; a non-zero
delta needs an explanation in the **Notes** column.

| Sunday      | Rows (legacy / Compass / Δ) | Net $ (legacy / Compass / Δ) | Geo CR $ (Δ) | Subs (active / zombies, Δ) | Notes |
|-------------|------------------------------|------------------------------|--------------|-----------------------------|-------|
| 2026-05-17  | _pending_                    | _pending_                    | _pending_    | _pending_                   | First reconciliation after Compass took over the daily-driver UI on 2026-05-10. |
| 2026-05-24  | _pending_                    | _pending_                    | _pending_    | _pending_                   | After `compass_writer.py` retirement (targeted 2026-05-20). Markdown summaries should now come only from Compass; legacy project no longer touches `knowledge-base/`. |
| 2026-05-31  | _pending_                    | _pending_                    | _pending_    | _pending_                   |       |
| 2026-06-07  | _pending_                    | _pending_                    | _pending_    | _pending_                   | Final reconciliation BEFORE cutover. Threshold for a clean cutover: zero discrepancies > $1.00 across last 12 months. |

## Cutover day — 2026-06-10

Filled in by `docs-keeper` after the [cutover checklist](legacy-cutover.md#cutover-day-2026-06-10-checklist)
runs.

| Field                                          | Value     | Notes |
|------------------------------------------------|-----------|-------|
| Final row count (Compass / legacy)             | _pending_ |       |
| Net sum, last 12 months (Compass / legacy)     | _pending_ |       |
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
