# Friday-review knowledge-base alignment

## Goal

Unify the Friday weekly-review markdown output so the same file lives
inside Compass's knowledge base at
`~/Library/Application Support/Compass/knowledge-base/finance/weekly/YYYY-MM-DD.md`,
and the Cowork-side scheduled task stops keeping a separate copy under
`~/Documents/Claude/Scheduled/finance-weekly-review/reports/`.

## Why now

Right now the Friday email pipeline (Cowork SKILL at
`~/Documents/Claude/Scheduled/finance-weekly-review/`) writes a
plain-text body to `reports/friday-YYYY-MM-DD.md` and sends an HTML email.
That report file is invisible to Compass — `dashboard_data.py:load_weekly_reviews`
reads from `knowledge-base/finance/weekly/` which the Cowork task never
touches.

Effect: Compass's Finance page shows "no weekly reviews yet" even though
the user has been receiving Friday emails for weeks. Two locations, two
truths, neither one complete.

## Acceptance criteria

- [ ] Compass's `finance-extractor.ts` gains a `writeWeeklyReview()`
      function that takes a date, a plain-text body, and an optional data
      blob, and writes to
      `knowledge-base/finance/weekly/YYYY-MM-DD.md` using the existing
      `updateKnowledgeFile()` pattern.
- [ ] IPC handler `finance:write-weekly-review` calls it; exposed on
      `window.api.finance.writeWeeklyReview()` with type defs.
- [ ] MCP tool `finance.write_weekly_review` (in `mcp/compass-mcp/`)
      wraps the IPC so the Cowork scheduled task can write to Compass's
      knowledge base from outside Electron.
- [ ] The `finance-weekly-review` SKILL.md (in
      `~/Documents/Claude/Scheduled/`) is updated in a doc-PR to call the
      MCP tool instead of writing to its local `reports/` directory.
- [ ] Old reports under `~/Documents/Claude/Scheduled/finance-weekly-review/reports/`
      get a one-shot backfill into the knowledge base (script noted below).
- [ ] After backfill, `reports/` is deleted from the scheduled-task dir;
      the Friday pipeline writes only to Compass's knowledge base going
      forward.

## Approach

### Compass side

```ts
// electron/knowledge/finance-extractor.ts (additions)

export async function writeWeeklyReview(args: {
  date: string                  // 'YYYY-MM-DD'
  bodyMarkdown: string          // plain-text body from the SKILL
  dataJson?: Record<string, unknown>  // optional structured payload to embed as frontmatter
}): Promise<{ path: string }> {
  const filename = `${args.date}.md`
  const fullPath = join(KNOWLEDGE_DIR, 'finance', 'weekly', filename)
  const frontmatter = args.dataJson
    ? `---\n${stringify({ date: args.date, ...args.dataJson })}---\n\n`
    : `---\ndate: ${args.date}\n---\n\n`
  const content = frontmatter + args.bodyMarkdown
  await updateKnowledgeFile(fullPath, content)
  return { path: fullPath }
}
```

`updateKnowledgeFile()` already handles the `.prev` snapshot and the
auto-updated-by header pattern.

### IPC

```ts
// electron/ipc/finance.ts
ipcMain.handle('finance:write-weekly-review', async (_event, args) => {
  return writeWeeklyReview(args)
})
```

### MCP tool

`mcp/compass-mcp/` gains:

```
finance.write_weekly_review
  input:  { date: string, bodyMarkdown: string, dataJson?: object }
  output: { path: string }
```

Thin wrapper around the IPC.

### Cowork-side SKILL update (doc PR, separate from Compass)

In `~/Documents/Claude/Scheduled/finance-weekly-review/SKILL.md` Step 13:

Before:
```
cp $TASK_DIR/.last-email-body.txt $TASK_DIR/reports/friday-$(date +%Y-%m-%d).md
```

After:
```
DATE=$(date +%Y-%m-%d)
BODY=$(cat $TASK_DIR/.last-email-body.txt)
DATA=$(cat $TASK_DIR/.last-email-data.json)

# Call MCP — writes into ~/Library/Application Support/Compass/knowledge-base/finance/weekly/$DATE.md
mcp_call compass finance.write_weekly_review \
  date="$DATE" bodyMarkdown="$BODY" dataJson="$DATA"
```

(Exact MCP invocation syntax depends on the runner — `claude mcp` CLI or
`osascript`.)

### Backfill of historical reports

One-shot script `scripts/backfill-weekly-reviews.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeWeeklyReview } from '../electron/knowledge/finance-extractor'

const REPORTS = join(homedir(), 'Documents/Claude/Scheduled/finance-weekly-review/reports')

for (const f of readdirSync(REPORTS).filter((n) => n.endsWith('.md'))) {
  const m = f.match(/friday-(\d{4}-\d{2}-\d{2})\.md$/)
  if (!m) continue
  const date = m[1]
  const body = readFileSync(join(REPORTS, f), 'utf8')
  await writeWeeklyReview({ date, bodyMarkdown: body })
  console.log(`backfilled ${date}`)
}
```

Run once after the IPC ships. After verifying, the user can delete
`~/Documents/Claude/Scheduled/finance-weekly-review/reports/`.

## Test coverage required

- `finance-extractor.test.ts`:
  - `writeWeeklyReview()` creates the file at the right path
  - Re-running with the same date overwrites (and writes a `.prev`)
  - Frontmatter includes the data JSON when provided
- Integration: MCP tool round-trip writes a file the user can read

## Out of scope

- Reading the Friday report into the Compass Finance page UI as a "last
  email" card. Worth doing later; not part of this alignment.
- Reformatting the body markdown. The SKILL.md owns the body format; this
  plan just changes where it lands.
- Encrypting the report. Weekly review contains aggregate dollar amounts
  but no PII — same risk profile as the existing `profile/finances.md`.
  Stays in the unencrypted knowledge base.

## Suggested driver

`integration-implementer` for the extractor + IPC + MCP wrapper;
`docs-keeper` for the Cowork-side SKILL.md update (which is in
`~/Documents/Claude/Scheduled/`, outside this repo — handle as a follow-up
ops task referenced from this plan, not a Compass PR).

Small PR (~150 LOC + a tiny backfill script).
