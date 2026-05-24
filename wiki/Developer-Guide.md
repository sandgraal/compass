# Developer Guide

Everything you need to build on Compass. The canonical references live in
[`docs/`](https://github.com/sandgraal/compass/tree/main/docs); this page is the orientation map.

## Repository layout

```
electron/            # Main process (Node, full access)
  main.ts            # BrowserWindow + security flags + IPC registration
  preload.ts         # contextBridge — the ONLY IPC exposure (window.api)
  cron.ts            # node-cron sync scheduler
  paths.ts           # local data paths (honors COMPASS_HOME)
  db/                # Drizzle schema, client, migrations
  ipc/               # IPC handlers, one file per domain
  integrations/      # finance ingest, apple-calendar, etc.
  knowledge/         # writer, extractor, embeddings, suggestions, ollama
src/                 # Renderer (React, sandboxed — NO Node imports)
  pages/             # one component per route
  components/        # layout, ui, onboarding, CommandPalette
  store/             # Zustand app store
  types/electron.d.ts# window.api type surface
  quickCapture/      # tray capture window
mcp/compass-mcp/     # separate read-only MCP process
docs/                # design + architecture (canonical)
.claude/             # agents, skills, hooks, plugin manifest
e2e/                 # Playwright specs
```

## Commands

```bash
npm run dev          # Electron + Vite HMR
npm run build        # production build
npm run typecheck    # tsc for renderer + main
npm run check        # Biome lint + format check
npm run format       # Biome write
npm run test:run     # Vitest one-shot  ← use this, NOT `npm test` (watch mode)
npm run test:e2e     # Playwright
npm run db:generate  # drizzle-kit migration from schema
npm run db:migrate   # run migrations
npm run screenshots  # seed synthetic demo data + capture docs/images
npm run status       # refresh the project-status snapshot
```

Before committing: `npm run typecheck && npm run check && npm run test:run`.

## Hard constraints (Lefthook + hooks enforce these)

- Never write to `knowledge-base/`, `.vault/`, `.data/`, `.env*`, `*.db*` from the working tree.
- The renderer (`src/`) **never** imports Node/Electron — go through `electron/preload.ts` IPC.
- The vault key lives only in the OS Keychain via `safeStorage`. No plaintext on disk.
- All sensitive ops live in `electron/ipc/*` and validate inputs.

## Conventions

Strict TypeScript, function components, named exports (default only for pages), Tailwind semantic
tokens (no raw hex), Lucide icons, Zustand for app-wide state. Full rules:
[`docs/conventions.md`](https://github.com/sandgraal/compass/blob/main/docs/conventions.md).

### Adding an IPC handler
Always three files (the `add-ipc-handler` skill automates it):
1. Handler in `electron/ipc/<domain>.ts` — `ipcMain.handle('<domain>:<verb>', …)`, validate inputs,
   return `{ success, error? }`.
2. Expose in `electron/preload.ts` under the namespace.
3. Type in `src/types/electron.d.ts`.

Drift between these three is the leading source of bugs.

### Adding an integration
Schema → auth (OAuth/PAT, encrypted) → `sync<Service>()` → `update<Service>Knowledge()` extractor →
frontend card in `Integrations.tsx` → `window.api` type → tests. Full playbook:
[`docs/integrations.md`](https://github.com/sandgraal/compass/blob/main/docs/integrations.md) +
the `add-integration` skill.

### Adding a page
Use the `add-page` skill: route + sidebar entry + command-palette entry + page component.

### Adding a vault category
Use the `add-vault-category` skill: registers the category + field templates.

## Agent orchestration

Compass ships a full Claude Code agent stack — subagents (`bug-triager`, `migration-author`,
`security-auditor`, `integration-implementer`, `ui-polish`, `docs-keeper`, `director`), auto-loading
skills (`add-integration`, `add-ipc-handler`, `add-page`, `add-vault-category`, `safe-commit`,
`security-review`, `brand-style-check`), enforcement hooks, and the read-only MCP. Agents work in
isolated **git worktrees** so features ship in parallel. Full design:
[`docs/agent-orchestration.md`](https://github.com/sandgraal/compass/blob/main/docs/agent-orchestration.md).

## Testing

- **Vitest** for unit/integration, colocated as `*.test.ts`. No snapshot tests — test behavior.
- **Playwright** for E2E in `e2e/`.
- Mind the `better-sqlite3` ABI split (see [FAQ & Troubleshooting](FAQ-and-Troubleshooting)).

## Release flow

```bash
npm version patch        # bumps package.json + creates git tag
git push --follow-tags   # GitHub Actions builds, signs, publishes to GitHub Releases
```

CI (`.github/workflows/release.yml`) runs on macOS, builds via `electron-builder --publish always`,
and uploads `.dmg` + `latest-mac.yml`. If repo secrets `CSC_LINK` + `CSC_KEY_PASSWORD` are set the
build is **signed**; if they're absent the workflow logs a warning, sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, and **publishes an unsigned release** (it does not fail). Note
that macOS auto-update verifies signatures, so unsigned releases won't auto-update cleanly — set the
certs for production. **Never run `npm run release` locally** — let CI build reproducibly. The
running app picks up the new release on its next check.

## Related

- [Concepts & Architecture](Concepts-and-Architecture) · [Data & Storage Reference](Data-and-Storage-Reference) · [FAQ & Troubleshooting](FAQ-and-Troubleshooting)
