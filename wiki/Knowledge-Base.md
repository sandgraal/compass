# Knowledge Base

**Route:** `/knowledge` · **Sidebar:** Knowledge Base · **⌘K:** "Knowledge Base" / "Search knowledge base"

Your notes, as **plain markdown files on disk** — not a proprietary database. Files live at
`knowledge-base/<category>/<file>.md` in your data directory, so you can edit, grep, version, and
back them up with any tool. Compass watches the folder and re-indexes automatically when you edit
files externally.

## The editor

- **TipTap rich-text editor** over markdown. Select a file from the list to edit it; the empty
  state reads *"Select a file to start editing."*
- **Auto-save** with debounce — your changes persist as you type.
- Files are organized by **category** folders (e.g. `profile/`, `calendar/`, `inbox/`, `work/`,
  `drive/`).

## Wikilinks & backlinks

- Type **`[[Note Title]]`** to link between notes, Obsidian-style.
- Each note shows its **backlinks** — every other note that links *to* it — so you can navigate
  the graph in both directions (`knowledge:get-backlinks`).

## Search

Two complementary modes:

- **Full-text search** — fast keyword search across note bodies.
- **Semantic search** — local-embedding similarity ("find notes *about* X" even without the exact
  words). Embeddings are computed locally and stored at `.data/knowledge-embeddings.json`; there's
  no cloud call. You can rebuild the index from [Settings](Settings) if it drifts.

Global ⌘K search also reaches into note bodies — see [Search & Command Palette](Search-and-Command-Palette).

## Auto-updated notes & the diff view

Some notes are **maintained by Compass**, regenerated after each sync — e.g.
`calendar/upcoming.md`, `inbox/action-items.md`, `work/github-summary.md`, and the `profile/finances*.md`
summaries. Each carries a header like `> Auto-updated by Compass — <timestamp>`.

Before overwriting an auto-updated file, Compass saves a `.prev` snapshot. The editor toolbar then
shows a **diff** (GitCompare) button comparing the current file to its previous version. If there's
no `.prev`, there's nothing to compare and the button doesn't appear (empty state: *"No changes
detected."*). See [`docs/knowledge-extractor.md`](https://github.com/sandgraal/compass/blob/main/docs/knowledge-extractor.md).

## Suggestions

Compass can surface **suggested edits** (e.g. extracted people, dates, action items) as interactive
checkboxes you accept or dismiss. The baseline is regex extraction (always on); optional **Ollama**
enrichment runs locally only (default `http://localhost:11434`) and never makes outbound calls.

## Where it lives

| What | Where | Encrypted |
|---|---|---|
| Note files | `knowledge-base/<category>/*.md` | No (plain markdown — you own them) |
| File index | `knowledge_files` table in `.data/compass.db` | No |
| Embeddings | `.data/knowledge-embeddings.json` | No |
| `.prev` snapshots | next to each auto-updated file | No |

> Notes are **not** secrets. For passwords, account numbers, and sensitive identity/medical/legal
> data, use the encrypted **[Vault](Vault)** instead.

## Related

- [Ask Compass](Ask-Compass) — a RAG assistant that answers questions *grounded in these notes*.
- [Integrations](Integrations) — what populates the auto-updated notes.
