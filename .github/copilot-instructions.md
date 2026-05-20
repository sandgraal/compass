# Compass Copilot review instructions

Compass is a local-first personal life OS built with Electron 41, React 18, TypeScript, Drizzle/SQLite, and TipTap. Keep edits small, surgical, and consistent with existing patterns.

## Hard constraints

- Never write repo fixtures or generated data into `knowledge-base/`, `.vault/`, `.data/`, `.env*`, or `*.db*`.
- Renderer code in `src/` must not import Node or Electron APIs directly; go through `electron/preload.ts` and the typed preload bridges (`window.api`, `window.quickCaptureApi`).
- Sensitive work stays in main-process code. Vault keys and OAuth tokens stay encrypted with `safeStorage`, never reach renderer logs, and never get committed.
- Treat new runtime network calls or host allowlist changes as review-worthy; Compass is local-first and only existing integration/OAuth traffic should leave the machine.

## Review priorities

1. **Must-fix in this PR**: anything that breaks `npm run typecheck`, `npm run check`, `npm test`, or `npm run build`; causes user-visible regressions; introduces data-loss risk; or weakens the app's security/privacy model.
2. **Important**: missing validation, preload/type drift, broken error handling, or inconsistent patterns that are likely to cause follow-up bugs.
3. **Nice-to-have**: cleanup, naming, refactors, and style polish that do not change behavior.

## Do not flag

- The local-first architecture itself: SQLite on disk, `safeStorage` in the main process, and the preload bridge are intentional.
- Tailwind utility classes or Lucide icons when they already follow the existing semantic-token and sizing patterns.
- Page-level default exports; non-page components should still prefer named exports.
- Missing full-suite reruns when the author chose focused validation that clearly covers the diff. Ask for the exact missing command only when the changed files need broader coverage.

## Validation and PR expectations

- Fresh clones need `npm install` before validation.
- For code or config changes, prefer `npm run typecheck`, `npm run check`, `npm test`, and `npm run build` unless the diff is docs-only.
- PR descriptions should include a test plan with manual or automated verification steps.
- UI changes should include a screenshot or recording.
