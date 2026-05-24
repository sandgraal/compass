---
name: capture-from-web
description: Capture this page or idea into my Compass knowledge base as a note. Use when the user asks to "save this to Compass", "capture this page", "add this to my notes", "clip this", or "remember this" while looking at web content or a chunk of text.
---

# Capture from web

Saves what the user is looking at (a web page, an excerpt, a thought) as a
**proposed** markdown note in the Compass knowledge base. The note is created
only after the user approves it in the Claude Inbox.

## 1. Build the note

- Distill the source into clean markdown: an `# H1` title, a one-line summary, a
  few key bullets, and a **Source** line with the URL if there is one.
- Don't dump the whole page — capture the signal. Quote sparingly.

## 2. Pick a path

- Relative `.md` path under the knowledge base, kebab-case, in a sensible folder:
  e.g. `clippings/<slug>.md`, `research/<topic>.md`, `ideas/<slug>.md`.
- Must be a **relative POSIX path** — no leading `/`, no `..`, no backslashes or
  Windows drive letters. (The Compass approval step enforces this.)

## 3. Propose it

Call **`compass_propose_note`**:
- `path` — the relative `.md` path,
- `content` — the markdown you built,
- `mode` — `create` for a new note, or `append` to add to an existing one.

Then: "Proposed the note to your Claude Inbox — approve it in Compass to save it."

## Rules
- Propose, never write. The knowledge base is only touched on approval.
- Prefer `create`; use `append` only when the user names an existing note.
- Keep titles and paths human-readable.
