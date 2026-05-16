---
'compass': minor
---

**Ask Compass — in-app RAG assistant with BYO Claude/OpenAI key.** Tier 2 #7 from the May 2026 strategic review, the move that turns the knowledge warehouse into a query interface.

- New `/ask` page with a single-pane chat against the user's own notes. Each answer comes back with inline `[N]` citations and a clickable Sources panel below.
- Bring your own API key — Anthropic + OpenAI both supported. Keys encrypted at rest via the existing `crypto-vault` primitives (`.vault/assistant.enc`); only a masked tail (`sk-…1234`) ever crosses the IPC boundary.
- Retrieval composes with the merged semantic search (Phase 5.9): top-6 chunks via cosine when an embedding index exists, with a keyword-scan fallback when Ollama isn't running.
- Privacy posture: the question + the top-K knowledge snippets are the only things sent to the provider. Vault entries, task titles, transactions, calendar events — none of it leaves the machine.
- Cancel mid-request via the Stop button; one in-flight ask at a time aborts the previous one.
- Settings → AI assist gets a new BYO-key panel with per-provider key/model rows, active-provider toggle, and a per-key Clear button.
- ⌘K → "Ask Compass" pre-fills the chat with whatever the user typed in the palette.

21 new unit tests (vault round-trip + masking + active-provider invariants + prompt-assembly contract). 430/430 green, typecheck clean, 0 Biome errors.
