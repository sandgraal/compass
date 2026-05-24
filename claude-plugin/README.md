# Compass — Claude plugin (end-user)

Talk to your [Compass](https://github.com/sandgraal/compass) life OS from Claude
(Desktop, Cowork, or Code). This plugin bundles:

- the **read-only Compass MCP server** (tasks, calendar, knowledge base,
  finance *summaries*, habit streaks, sync/repo health), and
- five end-user **skills** that turn your data into routines:
  `weekly-review`, `budget-check`, `morning-brief`, `capture-from-web`,
  `plan-my-week`.

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

### Claude Code / Cowork
Add this directory as a plugin (or install from the marketplace once published).
The plugin registers the MCP server in `.mcp.json` and exposes the skills in
`skills/`.

### Claude Desktop (manual MCP config)
Until the one-click desktop bundle ships (Compass Phase 8.3), add the server to
your `claude_desktop_config.json`:

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
throwaway store). It opens the database **read-only**.

## Skills

| Skill | What it does |
|---|---|
| `morning-brief` | Today's tasks + calendar + payments due, as a tight brief. |
| `weekly-review` | Reviews the week (tasks, habit streaks, spend) and proposes next-week tasks. |
| `budget-check` | Reads finance **summaries**, flags overspend, proposes tax tags / recategorizations. |
| `plan-my-week` | Turns goals + upcoming events into proposed daily tasks. |
| `capture-from-web` | Saves the page/idea you're looking at as a proposed knowledge note. |

Each skill is read-first and routes any change through the proposal → approve
flow above.

## Requirements

- A local Compass install (the app owns the data store and the Claude Inbox).
- Node + `npx` available (the MCP runs via `tsx`).
