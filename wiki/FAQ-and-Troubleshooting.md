# FAQ & Troubleshooting

## Using Compass

**Where is my data?**
Under your OS application-data directory — on macOS, `~/Library/Application Support/Compass/`.
Settings → Data → *Open in Finder* takes you there. See [Data & Storage Reference](Data-and-Storage-Reference).

**Does anything leave my machine?**
Only OAuth tokens you grant (to pull your own Google/GitHub/bank data) and BYO-key AI requests you
trigger. There is no Compass server. See [Security & Privacy](Security-and-Privacy).

**Can the AI / Claude see my passwords?**
No. The [Vault](Vault) is categorically excluded from every AI surface, and finance is exposed only
as summaries — never raw transactions.

**I added an API key — where did it go?**
Encrypted into `.vault/assistant.enc`. After you set it, the raw key never re-crosses the IPC
boundary; the UI shows only a masked tail. Clear it from [Settings → AI assist](Settings#ai-assist-optional).

**My statements aren't importing.**
Confirm they're in the watched folder (default `~/Documents/Money/`, ≤3 subfolders deep) and are
`.csv` / `.xlsx` / `.pdf`. Compass ingests in place (it doesn't move files). Check the parser list
in [Finance](Finance) — unsupported banks may need the generic format or a Plaid link.

**The Vault keeps locking.**
That's the auto-lock timer (and focus-loss lock). Adjust it in
[Settings → Security & Privacy](Settings#security--privacy).

**Where do calendar/GitHub/Gmail items come from?**
[Integrations](Integrations) sync them in on a schedule. Force a refresh with *Sync all services*
from ⌘K.

**Update isn't showing.**
Compass checks ~3s after launch and every 4h. Force it via Settings → Updates → *Check now*.
macOS auto-update requires signed builds.

## Developer gotchas

These are the hard-won ones — see also [`docs/conventions.md` § Gotchas](https://github.com/sandgraal/compass/blob/main/docs/conventions.md#gotchas-agents--contributors).

**`npm test` hangs.**
`npm test` starts Vitest in **watch mode**. Use **`npm run test:run`** for a one-shot run.

**`NODE_MODULE_VERSION` error from SQLite.**
`better-sqlite3` has a native-ABI split: **Node-ABI** for `test:run` and `tsx` scripts,
**Electron-ABI** for the built app and Playwright. One install can't serve both.
- `npm run screenshots` handles the dance and leaves the repo Node-ABI (test-ready).
- After `npx electron-builder install-app-deps` (Electron-ABI), run **`npm rebuild better-sqlite3`**
  before tests/push. The `.db` file itself is ABI-independent.

**Isolating test/demo data.**
Set **`COMPASS_HOME`** to a throwaway dir to redirect the *entire* store (DB, vault, knowledge) so
you never touch the real `~/Library/Application Support/Compass`. `scripts/seed-demo.ts` refuses to
run unless `COMPASS_SEED_DEMO=1` **and** `COMPASS_HOME` is set to a non-real dir.

**Working in a git worktree.**
You can't `git checkout main` (the primary checkout holds it). Branch directly:
`git checkout -b <name> origin/main`. With `gh pr create`, pass `--head <branch> --base main`
explicitly. A fresh worktree may need a one-time `npm install` (the Electron binary can be missing).
The project uses **npm** — delete any stray `pnpm-lock.yaml` / `pnpm-workspace.yaml`.

**Date off-by-one.**
Date-only columns should use the **local** calendar day (build keys from
`getFullYear()/getMonth()/getDate()`, not `toISOString().slice(...)`). `finance_transactions.date`
and `habit_entries.date` follow this; `checklist_items.list_date` is still UTC (tracked cleanup).

**Subagents fail with "Prompt is too long."**
In long sessions with a large tool/MCP context, spawning subagents can exceed the prompt budget.
Do the work inline or start a fresh session.

## Related

- [Getting Started](Getting-Started) · [Developer Guide](Developer-Guide) · [Security & Privacy](Security-and-Privacy)
