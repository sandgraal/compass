# Compass ↔ Claude — Integration Design

> **Status: partially shipped.** This documents how Compass becomes a first-class, **bidirectional** Claude citizen. **Shipped:** the MCP **read + propose** tools (8.1), the in-app **Claude Inbox** approval surface (8.2), and the **end-user plugin + skills** (8.4/8.6). **Remaining (🔜):** the one-click Desktop bundle (8.3) and the embedded agent in Ask Compass (8.5). Per-item status is tagged below and in [`implementation_plan.md` § Phase 8](implementation_plan.md).

## Why

Compass holds the things you'd most want an assistant to reason over — your tasks, calendar, notes, money, habits — but on *your* machine, not a vendor's cloud. Claude is the assistant. The opportunity is to connect them **both ways** without surrendering the local-first, privacy-first contract:

- **Claude → Compass:** ask questions and *act* on your life data from Claude Desktop, Cowork, or Claude Code.
- **Compass → Claude:** embed Claude's agentic reasoning natively (plan my week, proactive insights) inside the app.

The hard constraint: *let an assistant help with your life OS without letting it silently mutate it or leak it.* The whole design below exists to satisfy that.

## Today (shipped)

| Direction | What exists | Where |
|---|---|---|
| Claude → Compass | stdio MCP with **read tools** (tasks, knowledge search/read, calendar, sync status, finance summaries, habit streaks, upcoming, repo commits/test-status/integration-health) **and `compass_propose_*` write-proposal tools** (task/note/txn-tag/habit-check) that enqueue to the Claude Inbox. **Vault excluded; finance raw rows excluded.** | `mcp/compass-mcp/index.ts`, `proposals.ts`, `.mcp.json` |
| Claude → Compass (act) | **Claude Inbox** — proposals land in `claude_proposals`; the user approves/rejects in-app and approval applies the change via validated write logic (re-validated as a trust boundary). | `electron/ipc/claude.ts`, `src/pages/ClaudeInbox.tsx` |
| Compass → Claude | "Ask Compass" — BYO Anthropic/OpenAI key, RAG over local notes. *(Agentic tool-use + caching is 8.5, 🔜.)* | `electron/ipc/assistant.ts`, `electron/integrations/llm-client.ts` |
| Packaging | **`compass`** end-user plugin (MCP + skills) for Desktop/Cowork/Code — requires a repo checkout (self-contained bundle is 8.3). Separate from the **developer** `compass-stack` plugin (subagents/skills/hooks for *building* Compass). | `claude-plugin/`, `.claude/plugin.json` |

<a id="claude-inbox"></a>

## Core architecture — the "Claude Inbox" (confirmed writes) ✅

The MCP server is a **separate process** that opens the main Compass DB (`compass.db`) **read-only**. It must never mutate app data. So writes are *proposals* appended to a **separate, append-only proposal inbox** (NOT the read-only main DB) — Compass stays the sole writer to its real data, and a human approves every change.

**Where proposals live (resolving the read-only constraint):** the MCP appends each proposal to a dedicated store it owns read-write — a JSONL file at `.data/claude-inbox.jsonl` (simplest), or its own small `claude-inbox.db` — distinct from the read-only `compass.db`. The running Compass app watches that store, mirrors entries into a `claude_proposals` table for status/history, and on approval writes the real change to `compass.db` / knowledge files via existing IPC. The MCP never touches `compass.db`, the vault, or knowledge files.

```mermaid
flowchart LR
  claude["Claude\n(Desktop / Cowork / Code)"] -->|"compass_propose_* tool"| mcp["compass-mcp\n(reads compass.db read-only)"]
  mcp -->|"append (read-write, separate store)"| q[("claude-inbox.jsonl\n(proposal inbox)")]
  q -->|"watch / poll"| app["Compass app"]
  app --> inbox["Claude Inbox\n(human-readable diff,\napprove / reject)"]
  inbox -->|"approve → existing write IPC (validated)"| db[("compass.db / knowledge files")]
  inbox -->|"reject → discard + log"| q
  subgraph excluded["Never exposed to Claude"]
    vault[["Vault (secrets)"]]
    raw["Raw finance rows"]
  end
```

**Invariants (non-negotiable):**
1. Claude **never** writes `compass.db`, the vault, or knowledge files — it only appends to the separate, append-only proposal inbox.
2. Compass remains the **sole writer**, executing approved proposals through its **existing, input-validating** IPC handlers.
3. **Every** mutation is **human-approved** in the Claude Inbox and **audit-logged**.
4. The **vault is never exposed** to any Claude surface (read or write).
5. Finance is exposed as **summaries/aggregates only** — never raw transaction rows.
6. Cloud LLM access stays **BYO-key, opt-in, local-first** (Ollama preferred).

## Phase 8 tracks (proposed)

### 8.1 MCP capability expansion ✅ *(shipped)*
Extends `mcp/compass-mcp/index.ts`:
- **New privacy-respecting reads:** `compass_finance_summary` (aggregates only), `compass_habit_streaks`, `compass_upcoming` (unified daily brief).
- **Propose-write tools** (enqueue only): `compass_propose_task`, `compass_propose_note`, `compass_propose_txn_tag`, `compass_propose_habit_check` — in `proposals.ts`; each validates input, opens no DB / touches no vault, and appends a `status:'pending'` proposal to the append-only inbox (`<app-data>/.data/claude-inbox.jsonl`). Note paths are relative `.md` only (traversal blocked).
- Per-tool unit tests in `proposals.test.ts` (validation + enqueue round-trip). The JSONL line schema (`{ id, createdAt, status, source, type, payload }`) is the contract 8.2 consumes — keep it stable.

### 8.2 Claude Inbox — approval surface — ✅ *(shipped)*
- ✅ `claude_proposals` table (`electron/db/schema.ts`, migration `0010`) + `electron/ipc/claude.ts` (`claude:list-proposals` / `approve-proposal` / `reject-proposal` / `clear-resolved`) via the canonical preload + `electron.d.ts` 3-file pattern.
- ✅ Ingest reads the append-only `claude-inbox.jsonl`, dedups by the MCP-minted UUID, and tolerates malformed/partial lines. Approve applies the change and records `approved` + a `resultRef`; an apply failure marks the row `failed` with the error (nothing partially written). Reject/clear manage lifecycle.
- ✅ **Trust boundary:** the JSONL is LLM-written, so every field is re-validated on apply — path traversal via the shared `safeJoin`, the shared `TAX_TAGS` whitelist, the list-type domain, strict booleans, explicit habit state. The vault is never touched.
- ✅ A review **page** (`src/pages/ClaudeInbox.tsx`, route `/claude-inbox`, sidebar + ⌘K entry) surfaces pending proposals with a human-readable summary per type and one-click approve/reject (reusing `Toast` + `ConfirmDialog`) plus clear-resolved.

### 8.3 Claude Desktop connector (DXT / `.mcpb`) 🔜
- Package `compass-mcp` as a one-click **desktop-extension bundle** (no dev toolchain) so any Claude Desktop user can connect their Compass. The **manual `claude_desktop_config.json` fallback is documented today** in `claude-plugin/README.md`; the remaining work is the bundled artifact, gated on packaging the `better-sqlite3` native dependency.

### 8.4 Cowork plugin (end-user) — ✅ *(shipped)*
- `claude-plugin/` is a new **end-user** plugin (distinct from the dev `compass-stack`): `.claude-plugin/plugin.json` + `.mcp.json` register the Compass MCP and expose the 8.6 skills, with an install README (incl. the Claude Desktop manual-config fallback). A Cowork/Desktop/Code session can now run "do my weekly review", "what's my morning brief", etc.

### 8.5 Embedded Claude agent in Ask Compass — ✅ *(shipped)*
- ✅ `assistant:agent` runs a **bounded Anthropic tool-use loop** (`electron/ipc/assistant.ts`). The client (`llm-client.ts`) gained tool-use + **`cache_control` prompt caching** — kept **HTTP-only, no SDK** to match the codebase's deliberate "don't pull in LLM SDKs" convention.
- ✅ Tools (`electron/integrations/assistant-tools.ts`): read `get_upcoming` + `get_finance_summary` (aggregates only), and `propose_task` — which **enqueues a `pending` `claude_proposals` row** (→ the Claude Inbox) rather than writing directly. The same propose→approve funnel as the MCP. Vault excluded; OpenAI keeps the single-shot RAG `ask`.
- ✅ Renderer **Agent toggle** in Ask Compass (`src/pages/Ask.tsx`) — routes through `assistant:agent`, shows the tool trace, and surfaces proposed changes as a banner linking to the Claude Inbox. Anthropic-only (auto-disabled for other providers).
- 🔜 More tools (notes, habits, txn-tag) and proactive-insights surfacing (spend anomalies, habit slippage).

### 8.6 Claude Skills for Compass — ✅ *(shipped)*
- `claude-plugin/skills/`: `morning-brief`, `weekly-review`, `budget-check`, `plan-my-week`, `capture-from-web`. Each is **read-first** (via the MCP read tools) and routes any change through `compass_propose_*` → the Claude Inbox approval flow — never a direct write. The vault is never exposed; finance stays at the summary level.

## Expert deep-dive (five lenses)

- **Integration architecture** — the read-only-MCP + proposal-queue split is what makes "confirmed writes" safe across a process boundary; the same propose→approve path serves Desktop, Cowork, Code, *and* the embedded Agent SDK, so there's one mutation funnel to secure and audit.
- **Security / privacy** — vault is categorically excluded; finance is summaries-not-rows; nothing mutates without a human; keys/tokens never leave the device except on user-triggered turns. The Claude Inbox is the consent + audit surface.
- **Product / UX** — the daily hook compounds: a **Claude-generated Morning Brief** (8.5/8.6) read *from* Compass, and "ask Claude to tidy my week" that lands as reviewable proposals *in* Compass. "Open in Claude" affordances on notes/tasks.
- **Platform / ecosystem** — the DXT bundle + Cowork plugin + skills library make Compass installable and discoverable wherever Claude runs; the MCP tool contract is the stable, versioned API.
- **Bidirectional flows** — *Claude→Compass:* "What did I spend on subscriptions last quarter?" (summary read) → "cancel-candidate list, add a task to review each" (proposals). *Compass→Claude:* Ask Compass runs "plan my week" agentically over calendar+tasks+goals, drafting a plan you accept into checklists.

## Build sequencing (when greenlit)
`8.1 → 8.2` (read + propose + inbox) is the spine. `8.3 / 8.4 / 8.6` are packaging on top. `8.5` is independent and high-value. Each ships as its own PR with tests.

## Related
- [`implementation_plan.md` § Phase 8](implementation_plan.md) — the tracked checklist (and Phase 7 for the broader platform roadmap; 8.5/8.6 realize parts of Phase 7 Tracks E + C).
- [`architecture.md`](architecture.md) — process boundary + IPC + security model the above builds on.
