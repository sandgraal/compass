# Claude & MCP

Compass works with Claude **both ways** — it exposes its data to Claude over MCP, and embeds an
assistant inside the app — without surrendering the local-first, privacy-first contract. The design
goal: *let an assistant help with your life OS without letting it silently mutate it or leak it.*
Full design: [`docs/claude-integration.md`](https://github.com/sandgraal/compass/blob/main/docs/claude-integration.md).

> **Two distinct things:** **Ask Compass** is the assistant *inside* the app (see [Ask Compass](Ask-Compass)).
> **The MCP + Claude Inbox** (this page) is how *external* Claude reads Compass and proposes changes.

## What ships today

| Direction | What it is |
|---|---|
| **Claude → Compass (read)** | A **separate, read-only** MCP process that opens `compass.db` with `readonly: true`. Registered for **Claude Code** (`.mcp.json`), **Claude Desktop** (a one-click `.mcpb` bundle), and **Cowork** (the end-user plugin). |
| **Claude → Compass (write)** | **Propose-only** tools that enqueue changes to an append-only inbox; nothing is written without your approval (the **Claude Inbox**). |
| **Compass → Claude** | **[Ask Compass](Ask-Compass)** — BYO-key RAG over your notes, plus an **agent mode** (Claude tool-use over your data → proposes changes to the Claude Inbox) and **5 Compass skills** (morning brief, weekly review, budget check, plan-my-week, capture-from-web). |

## The MCP tools

**Read tools** (privacy-respecting — vault excluded, finance summaries only):

- `compass_today_tasks` / `compass_tasks` — today's checklist / a date-range of tasks
- `compass_upcoming` — unified daily brief
- `compass_search_knowledge` / `compass_read_knowledge_file` / `compass_recent_notes` — your notes
- `compass_recent_calendar` — upcoming events
- `compass_timeline` / `compass_search_timeline` — your **Timeline** (summary + record search — the user-opted-in detail relaxation, scoped to `records` only)
- `compass_sync_status` / `compass_integration_health` — integration state
- `compass_recent_commits` / `compass_test_status` — repo introspection
- `compass_finance_summary` — **aggregates only, never raw rows**
- `compass_habit_streaks` — habit streaks

**Propose-write tools** (enqueue only — they open no DB and touch no vault):

- `compass_propose_task` · `compass_propose_note` · `compass_propose_txn_tag` · `compass_propose_habit_check`

Each validates its input and appends a `status:'pending'` proposal to `.data/claude-inbox.jsonl`.
Note paths must be relative `.md` (path traversal is blocked).

## The Claude Inbox (confirmed writes)

**Route:** `/claude-inbox` · **Sidebar:** Claude Inbox · **⌘K:** "Claude Inbox"

Because the MCP is read-only, Claude can never write your real data. Instead it *proposes* — and
you approve:

```
Claude → compass_propose_* → claude-inbox.jsonl (append-only) → Compass app → Claude Inbox (you approve) → real write via validated IPC
```

On the Claude Inbox page:

- **Pending proposals** are shown with a **human-readable summary** per type (empty state:
  *"No pending proposals."*).
- **Approve** → Compass *re-validates* the LLM-written payload (path safety via `safeJoin`, the
  shared tax-tag whitelist, list-type domain, strict booleans) and applies it through the same
  validated write logic the app uses, recording `approved` + a result reference. An apply failure
  marks the row `failed` with the error — nothing is partially written.
- **Reject** discards it; **Clear resolved** soft-clears resolved rows (stamped `cleared_at`; the
  append-only JSONL is never truncated, preserving dedup).

## The invariants (non-negotiable)

1. Claude **never** writes `compass.db`, the vault, or knowledge files — it only appends proposals.
2. Compass is the **sole writer**, via existing input-validating IPC.
3. **Every** mutation is **human-approved** and audit-logged.
4. The **vault is never exposed** to any Claude surface (read or write).
5. Finance is exposed as **summaries/aggregates only** — never raw transaction rows.
6. Cloud LLM access stays **BYO-key, opt-in, local-first** (Ollama preferred).

## Using it from Claude Code

The MCP is registered via `.mcp.json` in the repo, so a Claude Code session in the project can call
the `compass_*` tools directly. Set `COMPASS_HOME` to point at a specific data store if needed (see
[FAQ & Troubleshooting](FAQ-and-Troubleshooting)).

## Also shipped (since this page's first draft)

The Claude **Desktop** (`.mcpb`) + **Cowork** (plugin) connectors, the embedded **agent mode** for agentic
*"plan my week"* + proactive insights, and the **5-skill** Compass library all shipped in Phase 8. Build
the Desktop bundle with `npm run build:mcpb`. See [Roadmap & Status](Roadmap-and-Status).

## Related

- [Ask Compass](Ask-Compass) · [Security & Privacy](Security-and-Privacy) · [Data & Storage Reference](Data-and-Storage-Reference)
