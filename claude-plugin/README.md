# Compass — Claude plugin (end-user)

Talk to your [Compass](https://github.com/sandgraal/compass) life OS from Claude
(Desktop, Cowork, or Code). This plugin provides:

- a connection to the **Compass MCP server** — **read** tools (tasks, calendar,
  knowledge base, finance *summaries*, habit streaks, sync/repo health) **plus
  `compass_propose_*` tools** that enqueue changes for your approval (read +
  confirmed-write — see below), and
- five end-user **skills** that turn your data into routines:
  `morning-brief`, `weekly-review`, `budget-check`, `plan-my-week`,
  `capture-from-web`.

> **This plugin requires a local Compass repo checkout** — its `.mcp.json` runs
> the server from the Compass repo (`mcp/compass-mcp/`), so the plugin must live
> inside (or alongside) a Compass checkout. **Claude Desktop users don't need
> it:** the one-click `.mcpb` desktop extension (Phase 8.3, below) is
> self-contained.

> This is the **end-user** plugin. It is intentionally separate from the
> developer plugin (`compass-stack`, under the repo's `.claude/`) which ships
> subagents/hooks for *building* Compass.

## How writes work — confirmed, never silent

Claude can **read** your Compass data directly, but it can **never write to it**.
When a skill needs to change something it calls a `compass_propose_*` tool, which
appends a **proposal** to an append-only inbox. Nothing happens until you open
the **Claude Inbox** in the Compass app and click **Approve** — which applies the
change through Compass's own validated code. The **vault is never exposed**, and
finance is shared as **summaries only** (never raw transactions).

```
Claude (skill) ──compass_propose_*──▶ Claude Inbox (Compass app) ──you approve──▶ change applied
```

## Install

### Claude Desktop — one-click `.mcpb` bundle (recommended)
Download `compass-mcp-darwin-<arch>.mcpb` from the latest
[Compass release](https://github.com/sandgraal/compass/releases) (or build it
from a checkout with `npm run build:mcpb`) and double-click it — Claude Desktop
installs it as an extension. The bundle is self-contained (compiled server +
native SQLite binding); no Node toolchain or repo checkout needed. See
`mcp/compass-mcp/README.md` § Desktop extension for details.

### Claude Code / Cowork
Use this `claude-plugin/` directory as a plugin **from within your Compass repo
checkout** — its `.mcp.json` launches the server at
`${CLAUDE_PLUGIN_ROOT}/../mcp/compass-mcp/index.ts` (i.e. the repo's `mcp/`).
The plugin registers that MCP server and exposes the skills in `skills/`.

### Claude Desktop (manual MCP config fallback)
If you'd rather run from a checkout (e.g. to get the repo self-knowledge tools
the bundle omits), add the server to your `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "compass": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/compass/mcp/compass-mcp/index.ts"]
    }
  }
}
```

The MCP reads the Compass store under
`~/Library/Application Support/Compass` (override with `COMPASS_HOME` for a
throwaway store). It opens **`compass.db` read-only**; the `compass_propose_*`
tools never touch the DB — they append to the separate Claude Inbox for your
approval.

## Skills

| Skill | What it does |
|---|---|
| `morning-brief` | Today's tasks + calendar + payments due, as a tight brief. |
| `weekly-review` | Recaps today's open tasks, habit streaks, and this month's spend; proposes next-week tasks. |
| `budget-check` | Reads finance **summaries**, flags overspend, proposes tax tags / recategorizations. |
| `plan-my-week` | Turns your goals + the week's calendar events into proposed daily tasks. |
| `capture-from-web` | Saves the page/idea you're looking at as a proposed knowledge note. |

Each skill is read-first and routes any change through the proposal → approve
flow above.

> **Today's MCP read scope:** `compass_upcoming` returns **today's** daily
> checklist plus the next N days of *calendar events* (and payments due) — it
> does not yet enumerate a full week of *tasks*. The week-oriented skills work
> within that: they reason over today's tasks + the week's events, not a
> complete week-wide task list. Broader task reads are a planned MCP addition.

## Requirements

- A local Compass install (the app owns the data store and the Claude Inbox).
- Node + `npx` available (the MCP runs via `tsx`).
