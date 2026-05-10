# Legacy Excel pipeline cutover

## Goal

Retire the standalone Excel-based pipeline at
`~/Documents/Claude/Projects/Getting on top of finances/` cleanly on
**2026-06-10**, after a one-month parallel run validates Compass against it.

## Why now

Compass owns finance going forward (decided 2026-05-10). The legacy Python
pipeline (`08_scripts/ingest.py`, `dashboard_data.py`, `compass_writer.py`,
the Friday weekly-review SKILL, etc.) duplicates effort and creates two
sources of truth. The transition month exists so the user can spot any
divergence before tearing the safety net down.

## Transition rules (2026-05-10 → 2026-06-10)

1. **Drop CSVs into both inboxes.** Each new statement goes into
   `~/Documents/Money/` (Compass watcher) AND
   `~/Documents/Claude/Projects/Getting on top of finances/01_inbox/`
   (Python ingest). The hash-based dedupe makes this safe.
2. **Compass is the daily-driver UI.** The Finance page in Compass is what
   the user looks at day-to-day. The Excel dashboard artifact and the
   `dump_for_compass.py` JSON output are for spot-checks, not workflow.
3. **Reconcile weekly.** Each Sunday during the window:
   - Run `python3 08_scripts/dump_for_compass.py` in the legacy project.
   - Compare row counts, sums by category, sums by geo against Compass.
   - Log any mismatches in `docs/finance/cutover-reconciliation.md` (a
     simple table appended each week).
4. **The Friday weekly-review email keeps running** out of
   `~/Documents/Claude/Scheduled/finance-weekly-review/` — but its data
   source flips to the Compass DB partway through the window once
   `compass_writer.py` has been retired (see Step 5).
5. **Compass owns the markdown.** Once `electron/knowledge/finance-extractor.ts`
   in Compass is generating `profile/finances.md` etc. cleanly,
   `08_scripts/compass_writer.py` is deleted from the legacy project.
   Targeted: 2026-05-20.

## Cutover day (2026-06-10) checklist

- [ ] Verify total transaction count, sum by month, sum by category match
      between Compass DB and the final Python-generated `master_ledger.compass.json`.
      Threshold: zero discrepancies > $1.00 across last 12 months.
- [ ] Confirm CR ATM split rows reconcile (count of split-sibling rows = count
      of split-project rows).
- [ ] Confirm subscription audit shows the same active subs and zombies on
      both sides.
- [ ] Verify the Friday weekly-review email is sourcing from Compass DB and
      sending without errors for ≥ 2 weeks.
- [ ] Plaid integration is either live or explicitly punted (CSV watcher is
      still the daily-driver path) — either way, no further dependence on the
      Python pipeline.
- [ ] Take one final `dump_for_compass.py` snapshot, archive the JSON files
      alongside the xlsx in `02_archive/`.
- [ ] Tag the legacy project's git history (if any) or write a top-level
      `RETIRED.md` noting the date and the migration target.
- [ ] Move the project folder to `~/Documents/Claude/Archived/Getting on top of finances/`.
- [ ] Disable the scheduled tasks in `~/Documents/Claude/Scheduled/finance-weekly-review/`
      and `~/Documents/Claude/Scheduled/finance-dashboard-refresh/`. Re-create
      equivalents inside Compass if still needed.
- [ ] Remove `~/Documents/Money/` from the Python project's expected layout
      (it's now exclusively Compass's).
- [ ] Update memory: replace the legacy "Getting on top of finances" entry
      with a one-line "Excel pipeline retired 2026-06-10, Compass owns
      finance" pointer.

## What gets kept from the legacy project

The Excel workbooks (`master_ledger.xlsx`, `debt_tracker.xlsx`, `budget.xlsx`)
are kept in the archive folder as a frozen historical reference. Source CSVs
in `02_archive/` stay too — they're the authoritative raw record going back to
April 2024 and predate Compass's coverage.

## Rollback plan

If during the window we find divergences > $50 in any month that we can't
explain, halt the cutover, file a bug against Compass's ingest, fix, re-run
the import. The Python pipeline keeps the safety net up until the variance
is zero.

## Suggested driver

`docs-keeper` for the reconciliation log; `director` to coordinate the
cutover-day checklist execution.

No PR — this is an operational doc that lives in the repo for reference
during the transition.
