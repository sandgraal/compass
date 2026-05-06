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

## When to use each

- **Skill** — small, repeating workflow ("add a new IPC handler"). Auto-loads on description match.
- **Slash command** — explicit user-typed entry point (`/safe-commit`). In 2026 these are now built on the skill system.
- **Subagent** — heavy or noisy work that should NOT pollute parent context. Examples: full repo grep, long migration, security audit. Spawns with own context window; returns only final output.
- **Hook** — deterministic safety net. Examples: block writes to data dirs, block force-push to main, auto-run codegen on schema edits. Runs at the system level — not "should we?" but "this can't happen."

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

Configured in `.github/workflows/claude-review.yml` (planned). On every PR:
1. `claude-code-action@v2` triggers
2. Spawns `security-auditor`, `ui-polish`, `bug-triager` in parallel
3. Each posts inline comments on the diff
4. Author addresses → re-runs on push

## Background scheduled-task agents (planned)

Outside the PR loop, these run on a cron:
- **Nightly** `bug-triager` against `main` → opens issues for new TODOs/dead code/audit findings
- **Weekly** `docs-keeper` → diffs `docs/*` against code reality, opens correction PR
- **Monthly** `security-auditor` → full sweep of IPC handlers + vault layer

These pair with the Compass MCP server (`mcp/compass-mcp/`) so the agent can also pull live state from the running app.
