# Strategic review — May 2026

> Audit snapshot taken **2026-05-18**. Living document `docs/implementation_plan.md` is the operational tracker; this file is the *why* behind the current shape of that tracker.

## TL;DR

- **Phase 4.6 (Plaid) is the active critical path** — 3 of 6 PRs merged (#82 client wrapper, #83 Link flow, plus PR 1 schema + PR 2a vault layer). PR 4 (sync loop), PR 5 (Integrations UI), PR 6 (daily cron) remain.
- **Phase 4.7 legacy Excel cutover is 23 days out** (target **2026-06-10**). Reconciliation log at [`docs/finance/cutover-reconciliation.md`](finance/cutover-reconciliation.md) exists; it needs daily entries from now through cutover day.
- **Accumulated code-health debt** — 9 of 13 IPC modules lack `.test.ts`, 10+ silent `catch {}` blocks, 78 standing biome warnings, 8 type-safety escapes in production files. None individually critical; together they're a Phase 6 of their own.
- **Claude Code platform has moved** since Phase 0+ landed. Three features (SessionStart hooks, UserPromptSubmit guardrails, subagent memory) move the agent-success needle and are worth a Phase 0++ refresh.

---

## What shipped since the last plan update

| Phase row | What | Where | Commit |
|---|---|---|---|
| 5.10 | Vault auto-lock | `src/pages/Vault.tsx`, `src/pages/Settings.tsx` | (Phase 5 batch) |
| 5.11 | Habit streaks badges | `src/lib/habit-streaks.ts` | (Phase 5 batch) |
| 5.12 | Ask Compass — in-app RAG assistant | `src/pages/Ask.tsx`, `electron/ipc/assistant.ts` | PR #79 |
| 5.13 | Apple Calendar RRULE + RDATE expansion | `electron/integrations/apple-rrule.ts` | PR #80 |
| 5.14 | Spotlight-friendly knowledge mirror | `electron/integrations/spotlight-mirror.ts`, `electron/ipc/spotlight.ts` | PR #81 |
| 4.6 PR 1 | `plaid_items` schema + columns on `financeAccounts` | `electron/db/schema.ts`, migration `0009` | `fc3a41d` |
| 4.6 PR 2a | Encrypted Plaid vault layer | `electron/lib/crypto-vault.ts`, `electron/integrations/plaid/vault.ts` | (PR earlier this week) |
| 4.6 PR 2b | Plaid SDK client wrapper | `electron/integrations/plaid/{config,client}.ts` | PR #82 (`ce8f53c`) |
| 4.6 PR 3 | Plaid Link flow + child BrowserWindow | `electron/integrations/plaid/link.ts`, `electron/ipc/plaid.ts` | PR #83 (`62529ac` + fixes `5761daf`, `3d79c5f`) |

---

## Plan-vs-reality discrepancies (the diff that motivates this review)

1. The **status snapshot** at the top of `docs/implementation_plan.md` lacks a row for Phase 5 (cont.) — §5.10–5.14 ship under it but the tracker doesn't reflect them.
2. The **"Deferred to Phase 5+" list** at the bottom of the plan (L262–271) still names items that already shipped:
   - "Habit streaks badges" → shipped as §5.11
   - "Privacy auto-lock" → shipped as §5.10
   - "Bulk operations in Daily" → shipped (PR #78)
   - "Distraction-free reading mode" → shipped (PR #78)
   - "Apple Spotlight integration" → shipped as §5.14
   - "RRULE expansion for Apple Calendar" → shipped as §5.13 (and the list contains a **duplicate entry** on L268 and L271)
   - "In-app AI assistant panel" → shipped as §5.12
3. `electron/integrations/plaid/vault.ts` still types `PlaidEnv` as `'sandbox' | 'development' | 'production'` even though Plaid retired `development` in 2024. `client.ts` rejects it correctly; the vault union is just out of sync. Worth a one-line follow-up.

---

## Outstanding work, ranked

| # | Item | Phase | Why this order |
|---|---|---|---|
| 1 | Plaid PR 4 — `/transactions/sync` cursor loop | 4.6 | Finish what's started. Critical path to killing the Sunday CSV ritual. Memory pointer at `~/.claude/projects/-Users-christopherennis-Websites-compass/memory/plaid_phase_4_6_status.md` |
| 2 | Plaid PR 5 — Integrations card UI + Accounts "linked" badge | 4.6 | User-visible payoff; can run in parallel with PR 6 |
| 3 | Plaid PR 6 — Daily 06:00 cron + error UX | 4.6 | Closes the loop |
| 4 | Phase 4.7 — Cutover reconciliation log | 4.7 | Time-bound (2026-06-10). Daily entries through cutover day |
| 5 | Phase 6 — Code-health debt | 6 (NEW) | Backfill IPC tests, drain empty catches, clear biome warnings |
| 6 | Phase 0++ — Claude Code platform refresh | 0++ (NEW) | Adopt SessionStart hooks, subagent memory, and the rest |

---

## Phase 6 — Code-health debt (NEW)

Five workstreams, ranked by impact × ease.

### 6.1 IPC test coverage backfill

Nine of thirteen IPC handlers in `electron/ipc/` have no test sibling:

| File | Risk | Priority |
|---|---|---|
| `electron/ipc/vault.ts` | Security-critical (vault encryption invariants) | **P0** |
| `electron/ipc/auth.ts` | OAuth tokens, security-critical | **P0** |
| `electron/ipc/finance.ts` | Largest handler in the project, most LOC | **P1** |
| `electron/ipc/sync.ts` | Sync trigger surface | **P1** |
| `electron/ipc/knowledge.ts` | Knowledge auto-update pipeline entrypoint | **P1** |
| `electron/ipc/settings.ts` | App-wide settings; restarts cron on change | P2 |
| `electron/ipc/spotlight.ts` | New (5.14); has integration coverage but not at handler seam | P2 |
| `electron/ipc/habits.ts` | Smaller surface | P3 |
| `electron/ipc/updater.ts` | Read-mostly | P3 |

*Owner: `integration-implementer` per file. One small PR each.*

### 6.2 Knowledge module test backfill

- [ ] `electron/knowledge/extractor.ts` — the auto-update pipeline's heart
- [ ] `electron/knowledge/finance-extractor.ts` — finance-specific extraction
- [ ] `electron/knowledge/writer.ts` — markdown seeding/writing

### 6.3 Empty-catch sweep

Convert silent `catch {}` to `catch (err) { console.warn('[area]', err) }` in:

```
electron/menu-bar.ts:206, :251, :268
electron/url-scheme.ts:65
electron/cron.ts:48, :125
electron/integrations/finance-watcher.ts:133, :244
electron/integrations/apple-calendar.ts:263, :271
```

Single PR. ~20 minutes.

### 6.4 Biome warning cleanup

78 standing warnings; concentrated in:

- `electron/integrations/finance.ts:64-66` — `noAssignInExpressions` ×3 (regex match assignments inside `if`)
- `src/pages/Weekly.tsx:28` — `useExhaustiveDependencies` ×4
- `src/pages/Weekly.tsx:129/143/150` — `useButtonType` ×3
- `src/pages/Weekly.tsx:360` — `noLabelWithoutControl`
- `src/pages/Weekly.tsx:313` — `noArrayIndexKey`
- `electron/ipc/knowledge.ts:214` — `noAssignInExpressions`

After cleanup, add `--max-diagnostics=0` to the Biome step in CI so future PRs can't re-introduce them.

### 6.5 Type-safety escape audit

Eight occurrences across five production files:

```
electron/preload-quick-capture.ts
electron/preload.ts
electron/ipc/finance.ts
src/pages/Ask.tsx
src/pages/Finance.tsx
```

Audit each. Most are likely fixable now that the schema is stable.

---

## Phase 0++ — Claude Code platform refresh (NEW)

The platform shipped meaningful features since Phase 0+ landed. Sources: [Claude Code best practices](https://code.claude.com/docs/en/best-practices), [Plugins blog](https://claude.com/blog/claude-code-plugins), [Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks).

### 0++.1 SessionStart hook

Auto-inject project state (current branch, last commit, sync queue, test status) into every new session. The existing [`scripts/project-status.ts`](../scripts/project-status.ts) already emits the right shape — wrap it.

**File to create:** `.claude/hooks/session-start.sh`
**Wire it in:** `.claude/settings.json` under `hooks.SessionStart`

### 0++.2 UserPromptSubmit guardrails

Pattern-match risky prompts in `.claude/hooks/guardrails.sh`:
- "push" / "force push" + branch is `main` → warn loudly
- "commit" without staged files → suggest `/safe-commit`
- "delete" / "rm -rf" + path under data dirs → block (already exists for tool use; mirror at prompt level)

### 0++.3 Living-docs PostToolUse hook (was 0+.6)

Fire `docs-keeper` after edits to `electron/db/schema.ts`, `electron/preload.ts`, or `src/types/electron.d.ts` — these change the API surface and the docs always drift.

**Wire it in:** `.claude/settings.json` under `hooks.PostToolUse` with `matcher: "Edit|Write"` and a path-filter shell hook that delegates to the subagent.

### 0++.4 Background scheduled agents (was 0+.9)

Register via `CronCreate`:
- **Nightly** `bug-triager` — scan for new TODOs, dead code, unused deps
- **Weekly** `docs-keeper` — full sweep against the codebase
- **Monthly** `security-auditor` — fresh diff against `electron/ipc/vault.ts`, `auth.ts`, `main.ts`, `preload.ts`

### 0++.5 Subagent memory

Give `security-auditor` and `bug-triager` a `.claude/agents/<name>/memory/` directory. Instruct each in its system prompt to:
1. Consult `memory/MEMORY.md` before starting
2. Update memory with novel findings on completion

Long-running improvement: the agents get smarter over time as they accumulate project-specific tribal knowledge.

### 0++.6 MCP server self-knowledge expansion

`mcp/compass-mcp/index.ts` currently exposes 5 read-only tools. Add:
- `compass_recent_commits` — last N commits with subject + author + date
- `compass_test_status` — last vitest run summary (pulled from `.last-test-status.json` or similar)
- `compass_integration_health` — per-integration `lastSyncedAt` + `status` + `errorMessage` from `integrations` table

These let agents introspect without shelling out to `git`/`npm`.

---

## Phase 4.7 — Cutover ops (EXPAND)

The Excel pipeline at `~/Documents/Claude/Projects/Getting on top of finances/` retires **2026-06-10** (23 days from this review).

Action items:

- [ ] **Start daily reconciliation log** at [`docs/finance/cutover-reconciliation.md`](finance/cutover-reconciliation.md). One row per day from now through cutover, comparing Excel totals vs. Compass totals.
- [ ] **Tag the Excel project archive script** — when, by whom, and how. (Phase 4 verification says "the Excel project at … is in `~/Documents/Claude/Archived/` after 2026-06-10".)
- [ ] **Set the post-cutover redirect** — add a `README.txt` to the archived folder pointing to Compass and naming the cutover date.
- [ ] **Verify no live consumers** — search the user's setup for anything that still imports from `Getting on top of finances/`.

---

## Verification

After this review lands:

- `docs/implementation_plan.md` status snapshot reflects all current phases (0, 0+, 0++, 1, 2, 3, 4, 5 cont., 6).
- The deferred backlog contains only items genuinely deferred (no items that already shipped).
- `wc -l CLAUDE.md` is still ≤ 60.
- `docs-keeper` subagent's next sweep finds no further drift.

## Out of scope for this review

- Implementing Phase 6 or Phase 0++ rows (each is its own PR after this lands).
- Plaid PR 4 / 5 / 6 (existing momentum; plan in [`docs/finance/plaid-integration.md`](finance/plaid-integration.md)).
- Phase 4.7 cutover *content* (the daily log entries themselves) — this review just confirms the doc is ready to receive them.
