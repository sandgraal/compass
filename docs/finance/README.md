# Finance — forward roadmap plans

Each doc here is one PR-sized work unit, ordered as it should land. The
[Phase 4 section of `implementation_plan.md`](../implementation_plan.md#phase-4--finance-forward-roadmap)
is the canonical status tracker; this folder holds the per-feature briefs.

| Order | Doc | Owner agent(s) | Size |
|---|---|---|---|
| 4.1 | [`db-migrate-fix.md`](db-migrate-fix.md) | `migration-author` | small (~150 LOC) |
| 4.2 | [`geo-purpose-schema-promotion.md`](geo-purpose-schema-promotion.md) | `migration-author` + `integration-implementer` | small-medium (~250 LOC + migration) |
| 4.3 | [`tax-tagging.md`](tax-tagging.md) | `integration-implementer` | medium (~400–500 LOC) |
| 4.4 | [`net-worth.md`](net-worth.md) | `migration-author` + `integration-implementer` + `ui-polish` | medium-large (~700–900 LOC) |
| 4.5 | [`cash-flow-forecast.md`](cash-flow-forecast.md) | `integration-implementer` + `ui-polish` | medium (~500–700 LOC) |
| 4.6 | [`plaid-integration.md`](plaid-integration.md) | `director` orchestrating | multi-PR (~1,500–2,000 LOC) |
| 4.8 | [`dashboard-snapshot-ipc.md`](dashboard-snapshot-ipc.md) | `director` orchestrating | multi-PR (~600–800 LOC across 5 PRs) |
| 4.9 | [`knowledge-base-alignment.md`](knowledge-base-alignment.md) | `integration-implementer` + `docs-keeper` | small (~150 LOC) |
| ops | [`legacy-cutover.md`](legacy-cutover.md) | `docs-keeper` + `director` | operational, no code |

## How an agent should use these

1. **Read the doc end-to-end** before opening files. Each plan states goal,
   acceptance criteria, schema/IPC/UI scope, test requirements, and explicit
   out-of-scope.
2. **Spawn in a worktree** if working in parallel with other Phase-4 items
   (`scripts/worktree.sh new feat/finance-<slug>`).
3. **Follow the agent-orchestration conventions** in
   [`../agent-orchestration.md`](../agent-orchestration.md). Use the
   `add-ipc-handler` / `add-page` / `safe-commit` skills where they apply.
4. **Open the PR with a Changeset** (see `.changeset/`) describing the user-
   visible change.
5. **`security-auditor` is a merge gate** for anything that touches token
   storage, vault, CSP, or IPC sanitization (notably 4.6 Plaid).

## Cross-cutting concerns

- **No PII in markdown / knowledge-base.** Account masks (`****1234`) only.
- **No plaintext credentials on disk.** `safeStorage` everything.
- **Idempotent ingest.** Hash dedupe is the contract — nothing should bypass it.
- **`notes` is being narrowed.** After 4.2 ships, `notes` is reserved for
  user-authored content + the `rm:CATEGORY` token. Don't add new structured
  tokens to `notes`; add a column instead.

## Open questions (pre-implementation)

- **Forecast (4.5):** confidence intervals or single-line projection? Plan says
  single-line; revisit if user asks for a Monte-Carlo "good case / bad case"
  view.
- **Net worth (4.4):** how to value the CR property? Plan says manual edit
  (most accurate, lowest friction). An automated valuation feed (Zillow
  doesn't cover CR) is out of scope.
- **Plaid (4.6):** Plaid's CR institution coverage is thin. Decide whether
  CR-side accounts stay on the CSV-watcher path forever or if Belvo / a
  similar LATAM aggregator is worth a separate integration plan.
