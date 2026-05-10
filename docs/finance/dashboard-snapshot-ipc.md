# Dashboard snapshot via Compass IPC

## Goal

Replace the standalone Python script
`~/Documents/Claude/Projects/Getting on top of finances/08_scripts/dashboard_data.py`
with a first-class Compass IPC handler: `finance:get-dashboard-snapshot`.
Same JSON shape, same dedup/aggregation logic, but Compass is now the only
place where the dashboard query lives.

## Why now

Cowork's `finance-dashboard` artifact and the
`finance-dashboard-refresh` / `finance-weekly-review` scheduled tasks all
read the same JSON blob, currently produced by a Python script that opens
Compass's SQLite file directly in read-only mode. That's an OK transitional
hack but creates two problems:

- **Schema drift risk.** When `geo`/`purpose` columns get promoted
  (`geo-purpose-schema-promotion.md`), or new Phase-4 tables land
  (`forecast_overrides`, `finance_balance_snapshots`), every external script
  has to update its SQL in lockstep with Compass's Drizzle schema. An IPC
  handler hides that detail.
- **Stale code paths.** The Python script's `summarize()` duplicates logic
  that the Finance.tsx page already runs in-process (`auditSubscriptions`,
  geo aggregation, the L12-month rollups). When the UI code improves, the
  Python summary lags.

Centralizing the query in Compass makes Compass the single source of truth
not just for the data, but for the query shape.

## Acceptance criteria

- [ ] New IPC handler `finance:get-dashboard-snapshot` in
      `electron/ipc/finance.ts` returns the exact JSON shape that
      `dashboard_data.py`'s `summarize()` returns today (so the artifact's
      HTML doesn't need surgery — only the data fetcher changes).
- [ ] Snapshot includes (existing fields): `source`, `current_month`, `stats`,
      `by_category`, `by_subcategory`, `monthly_trend`, `top_merchants`,
      `anomalies`, `transactions` (last 50), `accounts`, `debt`,
      `budget_lines`, `compass`, `rules_count`,
      `l12_by_category`, `l12_top_merchants`, `geo_split`, `cr_purpose`,
      `subscriptions`, `weekly_reviews`, `overview_md`, `paths`.
- [ ] `source` field is always `"compass-db"` (no more Excel fallback —
      Compass owns the data).
- [ ] Exposed on the renderer via `window.api.finance.getDashboardSnapshot()`
      with a type def in `src/types/electron.d.ts`.
- [ ] **MCP exposure**: the existing Compass MCP server
      (`mcp/compass-mcp/`) gets a `finance.get_dashboard_snapshot` tool so
      the Cowork-side artifact can call it via `window.cowork.callMcpTool()`
      instead of relying on an embedded snapshot.
- [ ] The Python script `dashboard_data.py` is retained as a fallback for
      ≤ 1 release after this lands (it still works against Compass DB
      read-only), then deleted with a follow-up PR.
- [ ] `finance-dashboard-refresh` and `finance-weekly-review` SKILL.md files
      in `~/Documents/Claude/Scheduled/` get a doc PR that replaces the
      `python3 dashboard_data.py` invocation with the MCP tool call.

## Approach

### Server side (`electron/ipc/finance.ts`)

```ts
ipcMain.handle('finance:get-dashboard-snapshot', (_event, opts?: {
  monthOverride?: string   // 'YYYY-MM', for backfilling old snapshots
  limit?: number           // recent-txn cap, default 50
}) => {
  const db = getDb()
  return buildDashboardSnapshot(db, opts ?? {})
})
```

Move `buildDashboardSnapshot` into a new module
`electron/integrations/finance-snapshot.ts`. Internally it composes:

- `summarizeAccounts` (currently in `Finance.tsx`'s reducers)
- `summarizeMonthlyTrend` (port from `dashboard_data.py`)
- `summarizeCategories` (current-month + L12 — both via SQL)
- `summarizeTopMerchants` (current-month + L12)
- `auditSubscriptions(db)` (already exists in `finance-subscriptions.ts`)
- `summarizeGeoAndPurpose` (currently the JS aggregation inside
  `finance:get-geo-summary`)
- `loadWeeklyReviews` (port from `dashboard_data.py:load_weekly_reviews`)
- `loadOverviewMarkdown` (port from `dashboard_data.py:load_overview_md`)

After `geo-purpose-schema-promotion.md` ships, `summarizeGeoAndPurpose`
becomes a single SQL aggregation against the new indexed columns.

### MCP exposure

`mcp/compass-mcp/` already follows the `tool registration → handler → return
JSON` pattern (see how `knowledge.search` is wired, per
`docs/agent-orchestration.md`). Add:

```
finance.get_dashboard_snapshot
  input:  { monthOverride?: string, limit?: number }
  output: <same shape as IPC>
```

The MCP handler is a thin wrapper that calls the IPC method internally —
no new logic, just transport.

### Client side (`Finance.tsx`)

Replace the Promise.all of 6 separate IPC calls in `refresh()` with one
`getDashboardSnapshot()` call. The tabs read from a single, consistent
snapshot — eliminates the race where the Overview shows last week's
subscriptions and the CR & Subs tab shows this week's.

### Cowork artifact (`finance-dashboard/index.html`)

Replace the embedded `SNAPSHOT_DATA` blob with a live call:

```ts
async function fetchData() {
  // Live call to Compass via MCP — single source of truth.
  return await window.cowork.callMcpTool('compass.finance.get_dashboard_snapshot', {})
}
```

`mcp_tools` array on the artifact gets `mcp__compass__finance_get_dashboard_snapshot`
added. The Reload button in the artifact header re-fetches on click. The
6-hour scheduled refresh becomes redundant (kept for one release as a
fallback for offline use).

## Migration plan

1. **PR 1** — Land `finance:get-dashboard-snapshot` IPC + the
   `finance-snapshot.ts` module. Add tests. `dashboard_data.py` is still
   the dashboard's source.
2. **PR 2** — Expose via MCP server. Add an integration test that fetches
   the snapshot via MCP and asserts shape parity with `dashboard_data.py`'s
   output for the same DB.
3. **PR 3** — Update `Finance.tsx` to use the single-call snapshot.
4. **PR 4** — Update Cowork artifact + both SKILL.md files (out-of-repo
   doc PR in `~/Documents/Claude/`). Run them for one week alongside the
   Python script to verify parity.
5. **PR 5** — Delete `dashboard_data.py` and `08_scripts/summarize.py`
   from the legacy project. Update `TRANSITION.md` to note the script
   retirement.

## Test coverage required

- `finance-snapshot.test.ts`:
  - Output shape matches `dashboard_data.py`'s for the same fixture DB
    (json-schema match)
  - L12 windows are computed against `latestDate - 365` not `today - 365`
    (consistent with Python)
  - Subscription audit + geo summary are correctly nested
- `mcp/compass-mcp/finance.test.ts`:
  - Tool call round-trips correctly
  - Error handling when Compass isn't running

## Out of scope

- The live forecast snapshot — that's `cash-flow-forecast.md`'s job. The
  dashboard snapshot is retrospective.
- Pagination of `transactions`. The artifact only shows the latest 50; if a
  full-table view ever lands, add a separate `finance:get-transactions-page`
  handler.
- Caching. SQLite reads at this size are sub-millisecond; no cache layer
  needed.

## Suggested driver

`director` to orchestrate, since this spans 5 PRs across IPC + MCP + UI +
out-of-repo SKILL.md updates. `integration-implementer` handles PR 1, 2, 3.
`docs-keeper` handles PR 4 (it's mostly docs in `~/Documents/Claude/`).
`security-auditor` reviews PR 2 (MCP exposure adds a new external query
surface).

Single feature branch with sub-commits, OR multi-PR sequence — preference is
multi-PR so PR 1 can be live for a couple days before the artifact migration.
