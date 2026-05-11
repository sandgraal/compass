# Compass — Implementation Plan

> **Living document.** Updated whenever a feature ships or scope changes.
> The `docs-keeper` subagent (`.claude/agents/docs-keeper.md`) is responsible for keeping this in sync with reality after each merge.

## Status snapshot

| Bucket | Items | % done |
|---|---|---|
| **Phase 0** — Agent infrastructure | 7 sub-areas | 100% |
| **Phase 0+** — Leading-edge agent infra | 10 items | 80% (0+.6, 0+.9, 0+.10 deferred) |
| **Phase 1** — Critical bug fixes | 5 items | 0% |
| **Phase 2** — Remaining PRD features | 7 items | partial (2.1 vault edit shipped in PR #10 follow-up) |
| **Phase 3** — Beyond-PRD polish | 2 selected items | 0% |

PRD-completion of the running app: **~91%** (10 PRs merged through #10).

---

## Decisions locked in

| Question | Choice |
|---|---|
| Tooling stack | **Biome + Oxlint (CI fast-layer) + ESLint (React-only) + Vitest + Playwright + Knip + Lefthook + Renovate + Changesets + electron-trpc** + GitHub Actions CI |
| Phase 3 scope | **Onboarding wizard (3.1) + System notifications + tray quick-capture (3.2)** |
| Per-integration sync | **Implement now** in Phase 2.5 |
| Knowledge "Suggest edit" | **Regex baseline + opt-in Ollama** (local, privacy-preserving) |

---

## Phase 0 — Agent infrastructure

Modern (Nov 2025+) Claude Code best practice splits guidance into 4 layers. This phase puts all four in place so the rest of the work can be parallelized across agents.

- **CLAUDE.md** (≤ 60 lines) — always-loaded project context
- **Skills** (`.claude/skills/<name>/SKILL.md`) — auto-invoked playbooks
- **Subagents** (`.claude/agents/<name>.md`) — isolated parallel workers
- **Hooks** (`.claude/settings.json`) — deterministic enforcement

### 0.1 Root `CLAUDE.md` (≤ 60 lines, terse pointer doc)
- [x] Project (2 lines), Run, Architecture pointer, Conventions pointer, Implementation plan pointer, DO NOT touch list, Always-run-before-commit, Branch convention, Security boundary

### 0.2 `docs/` directory
- [x] `docs/implementation_plan.md` (this file)
- [x] `docs/architecture.md` — DB schema overview, IPC handler map, security model, data flow diagrams
- [x] `docs/conventions.md` — TS/React style, file naming, error handling pattern, IPC handler pattern, toast notification pattern
- [x] `docs/integrations.md` — how to add a new integration (Notion, Linear, etc.)
- [x] `docs/knowledge-extractor.md` — how the knowledge file auto-update pipeline works
- [x] Move existing `FINANCE_MODULE.md` → `docs/finance.md`

### 0.3 `.claude/skills/` — auto-invoked workflows
- [x] **`add-integration`** — DB schema → IPC → preload → types → UI card → extractor playbook
- [x] **`add-ipc-handler`** — handler + preload + type definition pattern
- [x] **`add-page`** — route + sidebar + command palette + page component
- [x] **`add-vault-category`** — vault category + field templates
- [x] **`safe-commit`** — typecheck + lint + draft conventional-commit + open PR
- [x] **`security-review`** — IPC sanitization, vault invariants, CSP changes
- [x] **`brand-style-check`** — verify tailwind tokens

### 0.4 `.claude/agents/` — subagents
- [x] **`bug-triager`** — read-only crawl for TODOs, dead code, unused deps
- [x] **`migration-author`** — Drizzle migration generator
- [x] **`security-auditor`** — diff review for vault/OAuth/IPC/CSP regressions
- [x] **`integration-implementer`** — heavy isolated impl of full integration end-to-end
- [x] **`ui-polish`** — accessibility + keyboard nav + states review
- [x] **`docs-keeper`** — keeps `docs/*` in sync with code

### 0.5 `.claude/hooks/` — enforcement (`.claude/settings.json`)
- [x] PreToolUse on Bash: block `git push --force` to main/master
- [x] PreToolUse on Write/Edit: block writes under data dirs (mirror pre-commit)
- [x] PreToolUse on Edit/Write: warn on `electron/ipc/vault.ts`, `electron/db/schema.ts`
- [x] PostToolUse on schema.ts edit: auto-run `npm run db:generate`
- [ ] PostToolUse on commit: append summary to `docs/CHANGELOG.md`

### 0.6 `.github/` — CI/PR scaffolding
- [x] `.github/workflows/ci.yml` — typecheck + lint + test + build on PR
- [x] `.github/workflows/security.yml` — weekly `npm audit`
- [x] `.github/dependabot.yml` — fallback (Renovate is primary)
- [x] `.github/PULL_REQUEST_TEMPLATE.md`
- [x] `.github/ISSUE_TEMPLATE/` (bug + feature)
- [x] `.github/CODEOWNERS`

### 0.7 Tooling — leading-edge stack
**Lint + format**: [x] Biome [x] Oxlint (CI fast-layer) [x] ESLint (React-only minimal config) [x] Knip
**Hooks**: [x] Lefthook (replaces Husky)
**Tests**: [x] Vitest [x] Playwright (E2E) [ ] coverage 70% on `electron/ipc/` + `electron/knowledge/`
**Type safety**: [x] `npm run typecheck` script [ ] electron-trpc (incremental adoption)
**Dependency hygiene**: [x] Renovate [ ] syncpack [x] remove `react-beautiful-dnd`
**Release**: [x] Changesets [x] electron-updater auto-update (GitHub Actions CI pipeline — `npm version patch && git push --follow-tags`)

---

## Phase 0+ — Leading-edge agent infrastructure (the "futuristic" tier)

- [x] **0+.1 Custom statusline** (`.claude/statusline/`) — branch + test status + sync queue length
- [x] **0+.2 Compass MCP server** (`mcp/compass-mcp/`) — read-only knowledge + tasks + calendar + sync status as MCP tools (vault excluded)
- [x] **0+.3 Output styles** (`.claude/output-styles/`) — code-mode, explain-mode, commit-mode
- [x] **0+.4 Plugin manifest** (`.claude/plugin.json`) — wrap whole `.claude/` as installable plugin
- [x] **0+.5 Director-pattern agent orchestration** (`.claude/agents/director.md`) — coordinates parallel subagents per feature
- [ ] **0+.6 Living docs PostToolUse hook** — auto-run docs-keeper on schema/preload edits
- [x] **0+.7 Parallel PR review pipeline** — `claude-code-action` runs security-auditor + ui-polish + bug-triager in parallel
- [x] **0+.8 Worktree workflow** — `scripts/worktree.sh` + `docs/agent-orchestration.md`
- [ ] **0+.9 Background scheduled-task agents** — nightly bug-triager, weekly docs-keeper, monthly security-auditor
- [ ] **0+.10 Project status JSON** (`.claude/project-status.json`) — agent-readable snapshot of repo state

---

## Phase 1 — Critical bug fixes

### 1.1 Fix dual `CommandPalette` mounting
**Bug**: `App.tsx` mounts `./components/CommandPalette` AND `AppLayout.tsx` mounts `../ui/CommandPalette`. Both have ⌘K listeners.
- [ ] Delete `src/components/ui/CommandPalette.tsx`
- [ ] Remove `import { CommandPalette }` and `cmdOpen` state + listener from `AppLayout.tsx`

### 1.2 Cron interval doesn't restart on Settings change
**Bug**: `restartCronJobs()` exists but `settings:set` never calls it.
- [ ] In `electron/ipc/settings.ts`, when `key === 'syncInterval'`, call `restartCronJobs()`

### 1.3 Cron `0` ("Manual only") crashes
**Bug**: `cron.schedule('*/0 * * * *', ...)` is invalid.
- [ ] In `restartCronJobs()` and `startCronJobs()`: if interval ≤ 0, stop and don't reschedule

### 1.4 Replace `alert()` and `confirm()` with toast/dialog primitives
- [ ] Promote Vault's `Toast` UX into `src/components/ui/toast.tsx` + `useToast()` hook
- [ ] Promote a `ConfirmDialog` into `src/components/ui/confirm-dialog.tsx` (Radix dialog already installed)
- [ ] Replace 5 `alert()` calls (`Settings.tsx`, `Daily.tsx`, `Integrations.tsx`)
- [ ] Replace 4 `confirm()` calls (`Settings.tsx`, `Vault.tsx`, `Integrations.tsx`)

### 1.5 Verify pre-commit still passes
- [ ] After Phase 0 changes, `git commit -m test` should not be blocked

---

## Phase 2 — Complete remaining PRD features

### 2.1 Vault inline edit form
- [x] **Shipped** in PR #10 follow-up — `Pencil` button + `updateEntry` via `vault:update-entry` IPC

### 2.2 Finance — account management UI
- [ ] List accounts grouped by type (debt vs asset) in `Finance.tsx`
- [ ] Inline add/edit/delete with ConfirmDialog (IPC `finance:upsert-account`, `finance:delete-account` exist)

### 2.3 Finance — transaction edit/delete
- [ ] Inline edit for category/subcategory/notes per row
- [ ] Hover-reveal delete with ConfirmDialog

### 2.4 Finance — categorization rules manager
- [ ] List rules (id, pattern, category, priority)
- [ ] Add/edit/delete via existing IPC

### 2.5 Per-integration sync frequency (DECIDED: now)
- [ ] `appSettings` keys `syncInterval:google`, `syncInterval:github` (fall back to global)
- [ ] Refactor `cron.ts` to a `Map<service, ScheduledTask>` with `startCronJobs`, `restartCronJobsFor(service)`
- [ ] Per-card 5m/15m/30m/1h/Manual select in `Integrations.tsx`
- [ ] Update Settings global "sync interval" copy to clarify it's the default

### 2.6 Weekly: "events attended" stat
- [ ] Count calendar events with `startAt < now` AND within current week → display next to task completion %

### 2.7 Knowledge "Suggest edit" — regex baseline + opt-in Ollama
**Baseline (always-on)**: regex extract sender names, attendees → append checkboxes to `inbox/suggestions.md`
**Opt-in Ollama**: Settings → "AI assist" toggle + endpoint URL + model picker
- [ ] `electron/integrations/ollama.ts` — wrapper around `/api/generate`
- [ ] Structured-output prompt extracts action items, people, dates as JSON
- [ ] Render checkboxes in KnowledgeBase with 🤖 vs 📝 indicators
- [ ] Privacy banner: localhost-only, never outbound to OpenAI/Anthropic

---

## Phase 3 — Beyond-PRD product improvements (DECIDED scope: 3.1 + 3.2)

### 3.1 Onboarding wizard
- [ ] Detect first launch (zero integrations + zero checklist + zero vault entries)
- [ ] 4-step modal: Welcome → Theme/Sync → Connect integration (skippable) → Done
- [ ] Persist `onboardingCompleted=true` in `appSettings` + Settings "Replay tour" button
- [ ] Playwright E2E spec

### 3.2 System notifications + macOS menu-bar quick-capture
**Notifications**: per-habit reminder time, daily roll-over reminder (default 10pm), Electron `Notification` API, click → deep link
**Tray**: macOS Tray icon with menu (Quick add task / Open / Sync now / Quit), frameless 320×80 popup window for quick-capture, global shortcut (default `Cmd+Shift+T`), error-dot indicator

---

## Backlog (deferred, considered but out of scope this round)

- Encrypted backup/restore (high value — Phase 4)
- Apple Calendar (iCal) local read
- Habit streaks badges
- Wiki-style `[[link]]` between knowledge files
- Global search via ⌘K (knowledge + vault titles + tasks inline)
- Privacy auto-lock (Vault re-auth after N min idle)
- Distraction-free reading mode
- Bulk operations in Daily checklist
- Apple Spotlight integration
- Apple Contacts import
- PWA / web companion

---

## Recommended PR sequence

| # | Branch | Phase items | Owner |
|---|---|---|---|
| A | `chore/agent-infrastructure` | Phase 0 + Phase 0+ scaffolding | docs-keeper / infra |
| F ←→ | `fix/dual-command-palette` | Phase 1.1 | any |
| G ←→ | `fix/cron-restart-and-zero-guard` | Phase 1.2, 1.3 | any |
| H ←→ | `feat/toast-confirm-primitives` | Phase 1.4 | ui-polish |
| J | `feat/finance-management-ui` | Phase 2.2, 2.3, 2.4 | feature agent |
| K | `feat/per-integration-sync` | Phase 2.5 | integration-implementer |
| L | `feat/weekly-events-attended` | Phase 2.6 | small PR, any |
| M | `feat/knowledge-suggestions-regex` | Phase 2.7 baseline | feature agent |
| N | `feat/knowledge-suggestions-ollama` | Phase 2.7 Ollama | integration-implementer |
| O | `feat/onboarding-wizard` | Phase 3.1 | feature agent |
| P | `feat/notifications-and-tray` | Phase 3.2 | feature agent |

`←→` = independent, parallelizable across worktrees.

---

## Verification

**Phase 0**: `tree -L 2 .claude/ docs/ .github/` shows structure; `wc -l CLAUDE.md` ≤ 60; `npm run typecheck && npm run check && npm test && npm run build` all pass; `npx knip` returns no unused deps; Lefthook fires on commit; `claude mcp list` shows `compass`.

**Phase 1**: ⌘K opens exactly ONE palette; sync interval change applies without restart; "Manual only" doesn't crash; vault delete uses ConfirmDialog (not native popup).

**Phase 2**: Vault password edit saves + history retains old; finance account add/edit/delete persists; Google→5m, GitHub→1h fire on own schedules; Weekly "events attended" matches; Gmail from new sender → 📝 suggestion appears, then 🤖 if Ollama enabled.

**Phase 3**: First launch shows wizard once; habit reminder fires; tray menu opens quick-capture popup; `Cmd+Shift+T` works from any app.
