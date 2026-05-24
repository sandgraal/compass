# Security & Privacy

Privacy isn't a feature of Compass — it's the architecture. This page is the consolidated threat
model and the guarantees that back the "your data never leaves your machine" claim.

## The one-sentence promise

> The only bytes that ever leave your device are OAuth tokens you explicitly grant (to pull *your
> own* data back) and BYO-key AI requests *you* trigger. There is no Compass server.

## Layers of protection

### 1. Local-first by default
All data — the SQLite DB, the encrypted vault, the markdown knowledge base — lives in your OS
application-data directory. Nothing is uploaded to a Compass backend (there isn't one).

### 2. The encrypted Vault
- **AES-256-GCM**, with a random 16-byte IV and 16-byte auth tag per blob.
- The **master key** is generated once and sealed by the **OS Keychain** via `safeStorage`
  (`.vault/key.enc`). It never leaves the Keychain except to be decrypted *in the main process*.
- **Plaintext secrets never hit disk.**
- The Vault page enables **content protection** (`setContentProtection(true)`) while open, blocking
  macOS screenshots and screen recording of the window.

### 3. OAuth tokens
- Stored encrypted (`.vault/oauth-<service>.enc`) using the same `safeStorage` mechanism.
- Kept in the main process — **never exposed to the renderer and never logged.**

### 4. Hardened renderer
- `contextIsolation: true`, `nodeIntegration: false`. The renderer cannot `require('fs')` or touch
  Node — it can only call typed functions on `window.api`.
- **Production CSP** blocks remote scripts (`script-src 'self'`) and `eval`, with an explicit
  allowlist for the OAuth/API endpoints you opt into.
- Every IPC handler **validates inputs** (type checks, path-traversal guards) and is the sole writer.

### 5. AI is opt-in and local-first
- [Ask Compass](Ask-Compass) prefers a **local Ollama** model; cloud keys are **BYO** and used only
  on requests you trigger.
- BYO keys are encrypted (`.vault/assistant.enc`) and never re-cross the IPC boundary after being set.

## What AI / Claude can never see

| Surface | Vault | Raw finance rows | Knowledge notes |
|---|---|---|---|
| **Ask Compass** (embedded) | ❌ never | ❌ (no raw rows) | ✅ (the point) |
| **MCP / Claude** (external) | ❌ never | ❌ summaries only | ✅ read-only |

- The **vault is categorically excluded** from every AI surface, read or write.
- **Finance is exposed only as summaries/aggregates** — never raw transaction rows.
- External Claude is **read-only** and can only *propose* writes; **every** change is human-approved
  in the [Claude Inbox](Claude-and-MCP#the-claude-inbox-confirmed-writes) and audit-logged.

## Security invariants (for contributors — do not break)

- Vault key never leaves the OS Keychain except via `safeStorage.decryptString()` in the main process.
- OAuth tokens stored encrypted, never logged, never sent to the renderer.
- Production CSP blocks all remote scripts.
- The renderer can never import Node — context isolation enforces it.
- The Vault page toggles `setContentProtection` on mount/unmount.
- The MCP process opens the DB `readonly: true` and never touches the vault or knowledge files.

See [`docs/conventions.md`](https://github.com/sandgraal/compass/blob/main/docs/conventions.md#security-invariants-do-not-break)
and the `security-review` skill / `security-auditor` agent.

## Related

- [Vault](Vault) · [Claude & MCP](Claude-and-MCP) · [Concepts & Architecture](Concepts-and-Architecture)
