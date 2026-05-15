---
'compass': minor
---

**Semantic search across the knowledge base via local Ollama embeddings** — Tier 2 #6 from the May 2026 strategic review.

The brutal critique was right: Compass had a knowledge warehouse and shipped no query interface beyond title-substring matching. This change adds a "find by meaning" path that runs entirely on-machine.

- `electron/knowledge/embeddings.ts` — paragraph-aware chunker (~700-char target, 1.5k hard cap), `embedText` against Ollama's `/api/embeddings`, JSON-on-disk index at `.data/knowledge-embeddings.json`, incremental builds via `(path, mtime)` reuse, model-version invalidation, cosine-similarity ranking with per-path deduplication.
- IPC: `knowledge:get-embedding-status`, `knowledge:rebuild-embeddings` (serial — refuses concurrent builds), `knowledge:semantic-search` (bounded query length, falls back gracefully when Ollama is offline or the index is missing).
- Settings UI: new rows under "AI assist (Ollama)" — enable toggle, embedding model field (default `nomic-embed-text`), rebuild button with timing + chunk-count summary.
- Knowledge Base UI: when enabled, the existing search input runs a semantic pass in parallel with the keyword search. Results show in a "By meaning" section above the keyword hits with a similarity-percentage badge. One-line hint when the index is missing or Ollama is unreachable — no toast spam.

Defaults to off. Same trust posture as the existing Ollama-backed suggestions: opt-in, local-only, no data leaves the disk.

18 new unit tests (cosine math, paragraph chunking, build incremental + model invalidation, ranking, dedup, model-mismatch refusal). 343/343 green, typecheck clean, 0 new Biome errors.
