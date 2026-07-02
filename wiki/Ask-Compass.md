# Ask Compass

**Route:** `/ask` · **Sidebar:** Ask Compass · **⌘K:** "Ask Compass"

A retrieval-augmented (RAG) assistant that answers questions **grounded in your own knowledge
base**. It finds the relevant note snippets, hands them to a model, and **cites the source notes**
in its answer — so you can trust where the answer came from.

## How to use it

- Type a question in the box — *"Ask anything about your notes… (⌘↵ to send)"*. Press **⌘↵** to send.
- The answer streams back with a **Sources** list of the notes it drew from.
- Each answer footnotes which **provider · model** produced it.

## Agent mode

Next to the input, an **Agent** toggle switches Ask Compass from plain retrieval-and-answer into a
bounded, Anthropic-only tool-use loop: instead of just reading pre-fetched note snippets, the model
calls tools to read your agenda and finance **summaries** directly, and can *propose* changes —
which land in the **[Claude Inbox](Claude-and-MCP)** for you to review and approve, the same
approval mechanism external Claude/MCP proposals use.

- Agent mode is only available when **Anthropic** is your active provider (Settings → AI assist) —
  the toggle is disabled otherwise.
- Vault entries and task/finance detail stay excluded even in Agent mode; only summaries are
  exposed to the tool loop.
- Plain Ask (Agent off) stays read-only: it composes local semantic search results into a prompt
  and returns a single grounded answer with no tool calls and no proposals.

## Bring your own key (local-first)

Ask Compass is **opt-in and BYO-key**. Configure it from this page or from
[Settings → AI assist](Settings#ai-assist-optional):

- **Local Ollama** is preferred — fully offline, no key, default endpoint `http://localhost:11434`.
- **Anthropic** or **OpenAI** — paste your own API key. The key is encrypted at `.vault/assistant.enc`
  and **never crosses the IPC boundary again** after you set it; the renderer only ever sees a
  masked tail. Requests are made from the main process (so CSP doesn't block them).

You pick the **active provider** and **model**.

## What it can and can't see

- **Can:** your [Knowledge Base](Knowledge-Base) notes (via local semantic search — top-K cosine
  over the embeddings index — with a keyword-scan fallback if no index exists yet).
- **Cannot:** your [Vault](Vault). Vault secrets are categorically excluded from every AI surface.

## How retrieval works

`assistant:ask` composes the local semantic search (Phase 5.9 embeddings) to pull the most relevant
snippets, builds a grounded prompt, and issues a single non-streaming request to your active
provider — this is the plain (Agent off) path.

`assistant:agent` is the second, agentic path behind the **Agent** toggle above: a bounded
Anthropic tool-use loop where the model reads your data via tools (rather than a single pre-built
prompt) and can propose writes that route through the Claude Inbox for approval.

## Ask Compass vs. Claude & MCP

- **Ask Compass (plain)** = Claude/OpenAI/Ollama embedded *inside* Compass, reading your notes,
  read-only.
- **Ask Compass (Agent mode)** = the same embedded surface, but Anthropic-only and tool-using — it
  can also *propose* changes, routed through the Claude Inbox for approval.
- **[Claude & MCP](Claude-and-MCP)** = external Claude (Claude Code today) reading Compass over a
  read-only connector and *proposing* changes you approve.

The clean line used to be "Ask Compass never writes, only external Claude/MCP proposes changes."
With Agent mode shipped, that's no longer strictly true — the distinction now is *plain Ask*
(always read-only) vs. *Agent mode or external Claude/MCP* (both can propose writes, both land in
the same Inbox for your approval).

## Related

- [Knowledge Base](Knowledge-Base) · [Settings](Settings#ai-assist-optional) · [Security & Privacy](Security-and-Privacy)
