# Ask Compass

**Route:** `/ask` · **Sidebar:** Ask Compass · **⌘K:** "Ask Compass"

A retrieval-augmented (RAG) assistant that answers questions **grounded in your own knowledge
base**. It finds the relevant note snippets, hands them to a model, and **cites the source notes**
in its answer — so you can trust where the answer came from.

## How to use it

- Type a question in the box — *"Ask anything about your notes… (⌘↵ to send)"*. Press **⌘↵** to send.
- The answer streams back with a **Sources** list of the notes it drew from.
- Each answer footnotes which **provider · model** produced it.

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
provider. There is no agentic tool-use loop yet (that's planned — see [Roadmap](Roadmap-and-Status)).

## Ask Compass vs. Claude & MCP

- **Ask Compass** = Claude/OpenAI/Ollama embedded *inside* Compass, reading your notes.
- **[Claude & MCP](Claude-and-MCP)** = external Claude (Claude Code today) reading Compass over a
  read-only connector and *proposing* changes you approve.

## Related

- [Knowledge Base](Knowledge-Base) · [Settings](Settings#ai-assist-optional) · [Security & Privacy](Security-and-Privacy)
