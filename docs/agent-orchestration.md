# Agent orchestration

How multiple Claude agents work on Compass in parallel without stepping on each other.

## Layers

| Layer | Where | Purpose |
|---|---|---|
| **CLAUDE.md** | repo root | always-loaded project context (≤ 60 lines) |
| **Skills** | `.claude/skills/<name>/SKILL.md` | auto-invoked playbooks for repeating workflows |
| **Subagents** | `.claude/agents/<name>.md` | isolated parallel workers with own context window |
| **Hooks** | `.claude/settings.json` | deterministic enforcement (block-list, validate, log) |
| **Output styles** | `.claude/output-styles/<name>.md` | response shape per agent role |
| **MCP servers** | `.mcp.json` + `mcp/compass-mcp/` | external tools the agent can call |
| **Statusline** | `.claude/statusline/` | live project state in the terminal |
| **Plugin manifest** | `.claude/plugin.json` | the whole stack as installable bundle |
| **Agent memory** | `.claude/agents/memory/<agent>/MEMORY.md` | persistent per-agent notes (filters, accepted risks, run log) that survive across scheduled runs |

## When to use each

- **Skill** — small, repeating workflow ("add a new IPC handler"). Auto-loads on description match.
- **Slash command** — explicit user-typed entry point (`/safe-commit`). In 2026 these are now built on the skill system.
- **Subagent** — heavy or noisy work that should NOT pollute parent context. Examples: full repo grep, long migration, security audit. Spawns with own context window; returns only final output.
- **Hook** — deterministic safety net. Examples: block writes to data dirs, block force-push to main, auto-run codegen on schema edits. Runs at the system level — not "should we?" but "this can't happen."
- **Agent memory** — a scheduled agent's durable state across runs (e.g. "don't re-flag this known false positive"). Read first, updated last, per the memory protocol in each agent's spec.

## Worktree workflow (parallel agents)

```bash
# Spin up an isolated worktree for one feature
scripts/worktree.sh new fix/cron-restart

# Equivalent to:
# git worktree add .claude/worktrees/fix-cron-restart -b fix/cron-restart
# (cd .claude/worktrees/fix-cron-restart && npm install)
```

Each worktree is a full checkout with its own `node_modules` (or symlinked). Agents work in isolated worktrees so three features can ship in parallel without merge conflicts.

When done:
```bash
scripts/worktree.sh remove fix/cron-restart
# Cleans up after the branch merges
```

## Director pattern (planned — `.claude/agents/director.md`)

For a feature spec like "Add Notion integration", the director:
1. Plans → identifies subtasks (DB schema, OAuth flow, sync function, extractor, UI card)
2. Spawns `migration-author`, `integration-implementer`, `ui-polish` in parallel via worktrees
3. Each subagent works in its worktree, opens a draft PR
4. Director assembles results, merges branches into one PR with a coherent commit message

This is harder than it sounds — director needs to detect when subagents make conflicting decisions. Initial implementation will be sequential (one subagent at a time, easier to debug); parallel execution is a v2.

## PR review pipeline

Shipped, in `.github/workflows/claude-review.yml`. On every PR (opened / marked ready / synchronize), gated on the `CLAUDE_REVIEW_ENABLED` repo variable so forks/new clones without an API key don't fail:
1. `anthropics/claude-code-action@v1` triggers
2. Runs `security-auditor`, `ui-polish`, `bug-triager` as three subagents in parallel (per each agent's `.claude/agents/<name>.md` spec)
3. Each posts inline review comments tagged with its name, plus a final summary comment with totals per category
4. Author addresses → re-runs on push

## Background scheduled-task agents

Shipped, dormant by default. Three workflows, each gated on the `CLAUDE_SCHEDULED_AGENTS_ENABLED` repo variable (does nothing — and costs nothing — until you `gh variable set CLAUDE_SCHEDULED_AGENTS_ENABLED --body true` and configure `ANTHROPIC_API_KEY`):
- **`.github/workflows/agent-nightly-triage.yml`** (06:00 UTC daily) — runs `bug-triager` against the whole repo, posts/updates a single rolling GitHub issue ("🌙 Nightly bug triage")
- **`.github/workflows/agent-weekly-docs.yml`** (05:00 UTC Mondays) — runs `docs-keeper` to reconcile `docs/architecture.md` + `docs/implementation_plan.md` against code reality; opens a `chore/weekly-docs-reconcile-<date>` PR only if something drifted
- **`.github/workflows/agent-monthly-security.yml`** (04:00 UTC on the 1st) — runs `security-auditor` focused on `electron/ipc/vault.ts`, `electron/ipc/auth.ts`, `electron/db/schema.ts`, `electron/main.ts`, `electron/preload.ts`; posts/updates a rolling issue ("🔒 Monthly security audit")

The nightly and monthly workflows read `.claude/agents/memory/<agent>/MEMORY.md` first (to honor existing filters/accepted risks) and write back to it at the end of the run per the memory protocol, then commit that file straight to `main` (non-fatal if branch protection rejects the push — the issue body is the durable record in that case).

These pair with the Compass MCP server (`mcp/compass-mcp/`) so the agent can also pull live state from the running app.
