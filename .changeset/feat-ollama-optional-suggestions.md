---
"compass": minor
---

Add opt-in Ollama AI augmentation for knowledge suggestions (Phase 4).

When the user enables "Use local Ollama for knowledge suggestions" in Settings, Compass will use a locally-running Ollama model to extract additional contact, employer, and date facts from synced Gmail and GitHub metadata. All processing stays 100% on-device — no data leaves the machine. Suggestions from the AI path appear with an "AI · Gmail" or "AI · GitHub" badge in the Knowledge Base so users can distinguish them from regex-derived proposals. If Ollama is not installed or not running, behaviour is identical to the existing regex-only path.
