# Knowledge auto-update pipeline

After each successful sync, Compass enriches the local knowledge base with structured data extracted from the synced records. This file explains how that pipeline works and where to extend it.

## Flow

```
Sync (electron/ipc/sync.ts)
  └─ DB upsert
  └─ extractor.<service>Knowledge(items)  ◄── you write this per integration
       └─ writer.updateKnowledgeFile(dir, path, content)
            ├─ if file exists: copy current → path + '.prev'
            └─ overwrite path with new content
  └─ sync:update event → renderer
       └─ KnowledgeBase auto-loads .prev for the diff view
```

## Writer (`electron/knowledge/writer.ts`)

Single low-level entry point: `updateKnowledgeFile(knowledgeDir, relPath, content)`.

The function does two things:
1. If the file exists, write its current content to `<path>.prev` (used by the diff view)
2. Overwrite `<path>` with the new content

There's also `readPrevKnowledgeFile(...)` for reading the snapshot back, used by `knowledge:get-prev` IPC.

`STARTER_FILES` in this file holds the seed templates that get written on first launch (only if the file doesn't already exist).

## Extractor (`electron/knowledge/extractor.ts`)

One async function per integration:
- `updateCalendarKnowledge(events)` → writes `calendar/upcoming.md`
- `updateGmailKnowledge(actions)` → writes `inbox/action-items.md`
- `updateDriveKnowledge(files)` → writes `drive/index.md`
- `updateGitHubKnowledge(items)` → writes `work/github-summary.md`

### Conventions

- Top of every auto-updated file: `> Auto-updated by Compass — <timestamp>`
- Use markdown tables when the data is rowy (calendar events, GitHub items)
- Use bulleted lists when the data is freeform (Gmail snippets)
- Sort newest-first or chronologically (whichever is more useful for the reader)
- Truncate long content with `…` and a "see full thread" link if available

### Idempotent

Extractors are pure functions of their input — calling them with the same data twice produces the same file. Don't append; always rewrite.

## Sibling extractor modules

The pipeline isn't limited to `extractor.ts` — several domains that don't map cleanly to a single external integration have their own extractor module alongside it, all calling the same `updateKnowledgeFile` writer and following the same conventions above:

- **`electron/knowledge/finance-extractor.ts`** — `writeFinancesOverview`, `writeFinancesDebt`, `writeFinancesMonthly`, and `writeAllFinanceKnowledge` (a convenience wrapper that calls all three) — writes the finance summary pages
- **`electron/knowledge/contacts-extractor.ts`** — `writeRelationships` — writes `relationships.md` from the contacts table
- **`electron/knowledge/records-extractor.ts`** — `updateRecordsKnowledge` — writes an overview page summarizing the Storehouse `records` timeline (counts, sources, span)

Follow the same pattern when extending any of these (or adding a new sibling module): pure functions of their input, idempotent rewrite (not append), and delegate the actual file write to `updateKnowledgeFile`.

## Diff view (KnowledgeBase.tsx)

The diff view (GitCompare button in the editor toolbar) compares the current file to `<path>.prev`. The `.prev` file is automatically created by `updateKnowledgeFile` before each overwrite. If no `.prev` exists, the button doesn't appear (no diff to show).

The `computeDiff` helper in `KnowledgeBase.tsx` is a simple LCS-based line diff. Will be extracted into `src/lib/diff.ts` for reuse + unit testing in Phase 0.7.

## Suggestions flow (Phase 2.7 — planned)

The "Suggest edit" feature will live in the same pipeline:

1. Regex baseline (always-on): extract sender names from Gmail, attendees from Calendar
2. Optional Ollama enrichment: structured-output prompt extracts action items, mentioned people, mentioned dates
3. Append to `inbox/suggestions.md` as `- [ ] <suggestion>` lines tagged 📝 (regex) or 🤖 (AI)
4. The Knowledge editor renders these as interactive checkboxes — checking one appends to the appropriate target file (e.g. `relationships.md`) and removes the suggestion

Privacy: Ollama is opt-in, requires a local endpoint (default `http://localhost:11434`), and never makes outbound calls.
