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
| `compass_finance_summary` | **Aggregate** finances only — net worth, per-month income/expense/net, current-month spend by category. Never raw transactions or account numbers |
| `compass_habit_streaks` | Each active habit's current + longest streak |
| `compass_upcoming` | Unified brief: today's tasks + next-N-days calendar events + payments due in 14 days |

`compass_recent_commits` / `compass_test_status` / `compass_integration_health` are **self-knowledge** tools (Phase 0++.6) for repo + integration introspection. `compass_finance_summary` / `compass_habit_streaks` / `compass_upcoming` are the Phase 8.1 reads that let Claude reason over your life data — `finance_summary` is deliberately **aggregates-only** to keep raw transactions inside the privacy boundary.

### Data isolation

The server reads the app DB **read-only**. It honors the same opt-in `COMPASS_HOME` override as `electron/paths.ts`, so tests/screenshots can point it at a throwaway store; unset, it reads the real app data dir.

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

## Desktop extension (`.mcpb`) — one-click Claude Desktop install

Phase 8.3 packages this server as a self-contained [MCP Bundle](https://github.com/anthropics/mcpb) so a Claude Desktop user can connect Compass without a repo checkout or dev toolchain:

```bash
npm run build:mcpb                  # bundle for this machine's arch
npm run build:mcpb -- --arch x64    # cross-arch (same OS only)
```

Output: `dist/compass-mcp-<os>-<arch>.mcpb`. Double-click it (or drag into Claude Desktop ▸ Settings ▸ Extensions) to install. Tagged releases attach the macOS bundles (arm64 + x64) automatically — see `.github/workflows/release.yml`.

What the build does (`scripts/build-mcpb.ts`):

1. esbuild-bundles `index.ts` (+ `dates.ts`, `proposals.ts`, the MCP SDK) into a single ESM file — `server/index.mjs`
2. npm-installs `better-sqlite3` into the staging dir so the **platform-prebuilt native binding ships inside the bundle**
3. writes `manifest.json` (built by `mcpb-manifest.ts`, version-synced with the root `package.json`, validated against the official schema)
4. smoke-tests the bundled server with an MCP `initialize` handshake (proves the native binding loads; skipped for cross-arch builds)
5. packs everything with `@anthropic-ai/mcpb`

**Bundled mode:** the manifest sets `COMPASS_MCP_BUNDLED=1`, which drops the two repo self-knowledge tools (`compass_recent_commits`, `compass_test_status`) — there is no source checkout inside a bundle (see `bundle-mode.ts`). Everything else behaves identically.

**Native-binding caveat:** the `better-sqlite3` binding is fetched for the **Node ABI of the machine that builds the bundle**. Build with the same major Node that Claude Desktop's runtime uses (CI uses Node 22). If Claude Desktop reports the extension failed to load after a Claude update, rebuild the bundle with a matching Node.
