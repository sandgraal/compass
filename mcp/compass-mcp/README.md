# compass-mcp

Read-only MCP server exposing the Compass app's local SQLite database and knowledge base as MCP tools — so Claude can answer "what's on my schedule today?" or "search my knowledge base for X" while coding.

## Tools

| Tool | Description |
|---|---|
| `compass_today_tasks` | Today's daily checklist items |
| `compass_search_knowledge` | Full-text search of knowledge-base markdown files |
| `compass_recent_calendar` | Calendar events in next N days |
| `compass_sync_status` | Last sync time + status per integration |
| `compass_read_knowledge_file` | Full contents of a specific markdown file |
| `compass_recent_commits` | Recent git commits on the current branch (sha, subject, author, date) |
| `compass_test_status` | Test inventory (file count + names); `run=true` executes the suite and returns pass/fail summary (opt-in — see below) |
| `compass_integration_health` | Per-integration health: status, last sync, last error, recent sync-event counts |

The last three are **self-knowledge** tools (Phase 0++.6): they let an agent introspect the repo (recent commits, test state) and the app's integration health without shelling out. `compass_recent_commits` + `compass_test_status` read the repo source tree (rooted at the repo, derived from the `index.ts` module location via `import.meta.url`); `compass_integration_health` reads the app DB.

### `compass_test_status` and command execution

Inventory mode (default) is read-only — it just walks the source tree for `*.test.ts(x)` files. Passing `run=true` executes `npm run test:run`, which spawns local scripts and may write caches/artifacts to disk. To prevent a model from triggering local command execution unprompted, that path is **disabled unless** the server is started with `COMPASS_MCP_ALLOW_TEST_RUN=1`; otherwise `run=true` returns an error explaining how to enable it.

## What's deliberately NOT exposed

- **Vault entries** (encrypted blobs in `.vault/`)
- **OAuth tokens**
- **Gmail message bodies**
- **Finance transactions** (PII risk)
- **Any DB write operations**

If you want richer access, modify `index.ts` carefully — but keep vault excluded.

## Run

```bash
cd mcp/compass-mcp
npm install
npm start
```

Or via the project root:

```bash
tsx mcp/compass-mcp/index.ts
```

## Register with Claude Code

The repo-root `.mcp.json` registers this server automatically when Claude Code starts in this project. The `mcp/compass-mcp` package is listed as an npm workspace, so running `npm install` at the repo root also installs this server's dependencies. Verify with:

```bash
claude mcp list
```

You should see `compass` in the list.
