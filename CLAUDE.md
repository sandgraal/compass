# Compass

Local-first personal life OS. Electron 41 + React 18 + TypeScript + Drizzle/SQLite + TipTap.
All user data stays on disk; only OAuth tokens leave the machine (and only to Google/GitHub).

## Run
- `npm run dev` — start Electron + Vite HMR
- `npm run build` — production build
- `npm run typecheck` — both renderer + main process
- `npm run check` — Biome lint + format check
- `npm run test:run` — Vitest unit tests, one-shot (`npm test` is *watch* mode — it won't exit)
- `npm run test:e2e` — Playwright E2E

## Pointers (do not duplicate the content here — go read these)
- Master plan + checklist → [`docs/implementation_plan.md`](docs/implementation_plan.md)
- Architecture, IPC map, security model → [`docs/architecture.md`](docs/architecture.md)
- TS/React style + IPC + toast patterns → [`docs/conventions.md`](docs/conventions.md)
- Adding a new integration → [`docs/integrations.md`](docs/integrations.md)
- Knowledge auto-update pipeline → [`docs/knowledge-extractor.md`](docs/knowledge-extractor.md)
- Agent orchestration / worktrees → [`docs/agent-orchestration.md`](docs/agent-orchestration.md)

## Hard constraints (Lefthook + hooks enforce these — failure ≠ "try harder")
- Never write to `knowledge-base/`, `.vault/`, `.data/`, `.env*`, `*.db*` from this repo's working tree
- Renderer (`src/`) NEVER imports Node/Electron — go through `electron/preload.ts` IPC
- Vault key lives in OS Keychain via `safeStorage`; nothing else. No plaintext on disk.
- All sensitive ops live in `electron/ipc/*` and validate inputs

## Commit / PR convention
- Branch: `feat/<short-slug>` or `fix/<short-slug>` or `chore/<short-slug>`
- Before commit: `npm run typecheck && npm run check && npm run test:run`
- Co-author Claude on every commit Claude touched

## Release flow (shipping a new version to the installed app)
```bash
npm version patch          # or minor / major — bumps package.json + creates git tag
git push --follow-tags     # GitHub Actions builds, packages, publishes to GitHub Releases
```
That release workflow uses the auto-injected `GITHUB_TOKEN` plus repo secrets `CSC_LINK` and
`CSC_KEY_PASSWORD`; tag pushes fail fast if macOS signing is not configured.
The running app detects the new release within 3 s of next launch (or 4 h periodic check)
and shows the UpdateBanner. See `.github/workflows/release.yml` for the full pipeline.
**Never run `npm run release` locally** — let CI do it so builds are reproducible.

## Sub-agents you can delegate to (see `.claude/agents/`)
`bug-triager` · `migration-author` · `security-auditor` · `integration-implementer` · `ui-polish` · `docs-keeper` · `director`

## Skills auto-load by topic (see `.claude/skills/`)
`add-integration` · `add-ipc-handler` · `add-page` · `add-vault-category` · `safe-commit` · `security-review` · `brand-style-check`
