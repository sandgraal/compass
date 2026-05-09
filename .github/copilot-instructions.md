# Copilot instructions for Compass

> Read this whenever you suggest code, write code, or review a PR in this repo.
> Detail beyond this file lives in [`docs/`](../docs) — link there from a comment, don't restate.

## What Compass is

Local-first personal life planning desktop app. **Electron 41 + React 18 + TypeScript + Drizzle/SQLite + TipTap + Tailwind.** Everything stays on the user's machine; only OAuth tokens leave (and only to Google + GitHub, scoped read-only).

## Hard constraints (always flag violations)

These are enforced by hooks and CI; treat any PR that breaks them as red.

- **Renderer never imports Node or Electron.** All filesystem, IPC, native code goes through `electron/preload.ts` → `window.api`. Flag any `import 'fs'` / `import 'electron'` in `src/`.
- **Vault data is AES-256-GCM encrypted.** Key lives in OS Keychain via `safeStorage`. Never write plaintext vault contents to disk, logs, or telemetry. See [`electron/ipc/vault.ts`](../electron/ipc/vault.ts).
- **OAuth tokens encrypted via `safeStorage` only.** Never in `.env`, never in plaintext on disk.
- **No telemetry, analytics, or outbound network calls** except OAuth and integration API calls (Google APIs, GitHub API), plus the existing Google Fonts hosts already allowlisted for the app shell (`fonts.googleapis.com`, `fonts.gstatic.com`). New runtime network calls or host allowlist additions should be flagged.
- **Path traversal on filesystem IPC.** Every handler that takes a relative path must validate containment with a separator-boundary or `path.relative()`-style guard (for example `fullPath === KNOWLEDGE_DIR || fullPath.startsWith(KNOWLEDGE_DIR + sep)` or rejecting relatives that start with `..`) before reading/writing. A bare `startsWith(KNOWLEDGE_DIR)` check is not sufficient.
- **Never write to** `knowledge-base/`, `.vault/`, `.data/`, `.env*`, `*.db*` from the working tree. Lefthook blocks commits; CI blocks merges.

## Stack — don't suggest replacements

| Concern | Tool — don't suggest alternatives |
|---|---|
| Lint/format | Biome (not ESLint+Prettier; ESLint kept only for `react-hooks` + `react-refresh`) |
| ORM | Drizzle (not Prisma, not raw SQL helpers) |
| Tests | Vitest (not Jest), Playwright for E2E |
| Hooks | Lefthook (not Husky) |
| Editor | TipTap (not Slate, not ProseMirror direct) |
| Icons | `lucide-react` only |
| Styling | Tailwind tokens — never raw hex (`#fff` ❌, `bg-foreground` ✅) |
| State | Zustand (no Redux, no MobX) |
| Routing | React Router v6 |
| Native binary | `better-sqlite3` (rebuilt against Electron via `electron-builder install-app-deps`) |

## Conventions to match

- **TypeScript strict.** No `any` without an inline `// biome-ignore lint/suspicious/noExplicitAny: <reason>` and a real reason. There's one legitimate `as any` in `electron/ipc/finance.ts` (Drizzle generic plumbing) — that's the bar.
- **Use the shared primitives, not native dialogs.** `useToast()` from `src/components/ui/Toast.tsx`, `useConfirm()` from `src/components/ui/ConfirmDialog.tsx`. Flag any new `alert()` / `confirm()` / `window.confirm()`.
- **Test colocation.** `foo.ts` → `foo.test.ts` next to it. We use `vitest`. Existing tests: `electron/integrations/finance-pdf.test.ts`, `electron/quick-capture-path.test.ts`, `electron/knowledge/suggestions.test.ts`.
- **IPC pattern is three-file.** New IPC = handler in `electron/ipc/*.ts` + bridge in `electron/preload.ts` + type in `src/types/electron.d.ts`. All three must be in the same PR.
- **Drizzle migrations.** Schema changes in `electron/db/schema.ts` require running `npm run db:generate` and committing the generated `electron/db/migrations/*.sql`. Existing user DBs upgrade in-place via `ensureColumn()` in `electron/db/client.ts`.
- **Conventional Commits.** Subject ≤ 72 chars, lowercase after the type, imperative mood. Always include `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` on commits Claude touched.
- **Branch naming.** `feat/<slug>`, `fix/<slug>`, `chore/<slug>`. One Changeset (`.changeset/*.md`) per user-visible PR.

## When reviewing PRs — flag these

| Severity | What to flag |
|---|---|
| 🔴 critical | Renderer importing Node/Electron; vault data leaking; OAuth tokens written plaintext; new IPC handler without input validation; path traversal not guarded |
| 🟠 important | New `alert()`/`confirm()`; missing migration for schema change; new `any` without justification; broken `useEffect` deps that hide stale closures; new top-level dep added without weighing against existing alternatives |
| 🟡 nice-to-have | Missing test for non-trivial new logic; raw hex colors instead of Tailwind tokens; new icon from outside `lucide-react`; commit message not Conventional Commits |

For each finding, include:
1. The exact file + line range
2. A 1-sentence rationale tied to a rule above
3. A suggested fix (concrete code, not "consider refactoring")

## When reviewing PRs — DON'T flag these

These are intentional, documented, or already tracked:

- **Demoted Biome rules** (warnings, not errors): `useExhaustiveDependencies`, `noAssignInExpressions` (in CSV date parsers), `noArrayIndexKey`, `useButtonType`, `noLabelWithoutControl`. They're warnings on purpose during the cleanup transition. A wholesale fix is tracked as a separate tech-debt PR, so don't raise these as standalone review findings on untouched existing code.
- **`as any` in `electron/ipc/finance.ts:56`** — Drizzle generic limitation, documented.
- **Lockfile churn during npm-version drift** — when `npm install` drops Linux-platform optional deps (`@emnapi/*`, `@electron/windows-sign`, etc.), the fix is `rm -rf node_modules package-lock.json && npm install --include=optional`. Don't suggest pinning npm or adding shims — this is a known pattern.
- **`alert()` / `confirm()` migrations** — most have been replaced; remaining ones are tracked. Don't propose half-replacements.
- **Tailwind dark theme** — Compass is dark by default. Don't suggest light-theme-first patterns.

## Performance & accessibility expectations

- Prefer stable list keys over `key={i}` from `.map((_, i) => ...)`; use a stable id when possible, especially in new or edited UI.
- Prefer `type="button"` for non-submit buttons, especially in new or edited UI.
- Icon-only buttons need `aria-label`.
- Click-only handlers on non-button elements (e.g. divs) need a corresponding `onKeyDown` / `role="button"` for keyboard parity.

## Test plan expectations

A PR description should include:
- A "Summary" with 1–3 bullets of what ships.
- A "Test plan" checklist:
  - `npm run typecheck` clean
  - `npx biome check .` 0 errors (warnings ok)
  - `npm run test:run` passes
  - At least one manual verification step
- A `.changeset/<slug>.md` for user-visible changes.

## Pointers (deep detail lives here, don't duplicate)

- Master plan / phase checklist → [`docs/implementation_plan.md`](../docs/implementation_plan.md)
- DB schema, IPC handler map, security model → [`docs/architecture.md`](../docs/architecture.md)
- TS/React style + IPC + toast patterns → [`docs/conventions.md`](../docs/conventions.md)
- Adding a new integration (Notion, Linear, etc.) → [`docs/integrations.md`](../docs/integrations.md)
- Knowledge auto-update + diff view + suggest-edit → [`docs/knowledge-extractor.md`](../docs/knowledge-extractor.md)
- Multi-agent orchestration via worktrees → [`docs/agent-orchestration.md`](../docs/agent-orchestration.md)

## Commit / PR templates

- Commit message format: see [`.claude/output-styles/commit-mode.md`](../.claude/output-styles/commit-mode.md)
- PR body template: [`.github/PULL_REQUEST_TEMPLATE.md`](./PULL_REQUEST_TEMPLATE.md)

---

Last updated: 2026-05. Update when stack pivots (e.g., Electron major bump, ORM swap), not for incremental features.
