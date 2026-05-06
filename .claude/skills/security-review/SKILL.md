---
name: security-review
description: Quick security check for IPC sanitization, vault encryption invariants, OAuth token handling, and CSP changes. Auto-loads when editing electron/ipc/vault.ts, electron/ipc/auth.ts, electron/main.ts, electron/preload.ts, or any file matching `**/csp*` or `**/security*`. Use the `security-auditor` subagent for the full audit; this is the inline checklist for everyday edits.
---

# Security review (inline)

Run this checklist before merging any change to security-critical files. For deeper audits, delegate to the `security-auditor` subagent.

## Checklist by file

### `electron/ipc/vault.ts`
- [ ] AES-256-GCM with random 16-byte IV per encrypt
- [ ] AuthTag verified on decrypt (`decipher.setAuthTag(authTag)` BEFORE final)
- [ ] Master key obtained ONLY via `getOrCreateKey()` (which uses `safeStorage`)
- [ ] No `console.log` of plaintext entries, IV, or key
- [ ] Path joins use `join(VAULT_DIR, ...)` — no user-controlled paths

### `electron/ipc/auth.ts`
- [ ] Tokens encrypted via `safeStorage.encryptString` before disk write
- [ ] Plain access_token/refresh_token never returned to renderer
- [ ] OAuth redirect is `127.0.0.1:<port>` (not `0.0.0.0` or external)
- [ ] PKCE used (code_challenge + code_verifier in flow)
- [ ] Token JSON files saved as `oauth-<service>.enc` in `.vault/`
- [ ] Failed exchanges don't leak the auth code into logs

### `electron/main.ts`
- [ ] BrowserWindow: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (acceptable — preload runs in separate context), `webSecurity: true`
- [ ] CSP enforced in production (NOT dev — dev needs unsafe-eval for HMR)
- [ ] CSP `connect-src` allowlists ONLY needed API hostnames
- [ ] CSP `script-src` excludes `unsafe-eval` in production
- [ ] `setWindowOpenHandler` returns `{ action: 'deny' }` (external links via `shell.openExternal`)
- [ ] No `app.commandLine.appendSwitch('disable-web-security')`

### `electron/preload.ts`
- [ ] All IPC exposure goes through `contextBridge.exposeInMainWorld('api', api)`
- [ ] No raw `ipcRenderer` exposed to renderer
- [ ] No Node modules (`fs`, `path`, `child_process`) re-exported

### `src/types/electron.d.ts`
- [ ] Type signatures match the actual handler returns (drift = bugs)

## Path traversal — every IPC handler that takes a path

```typescript
const fullPath = join(<ALLOWED_DIR>, relativePath)
if (!fullPath.startsWith(<ALLOWED_DIR>)) throw new Error('Path traversal blocked')
// or
if (relativePath.includes('..')) throw new Error('Path traversal blocked')
```

If you see a handler reading/writing/deleting a path WITHOUT this guard, flag it.

## Renderer — the renderer must NEVER:
- `import 'fs'`, `import 'path'`, `import 'child_process'`, etc.
- Use `eval`, `new Function`, `Function()`
- `dangerouslySetInnerHTML` with user input (TipTap output is OK because it sanitizes)

## When to escalate to the `security-auditor` subagent

- Touching the vault layer
- Adding a new integration with new tokens
- Modifying CSP
- Anything with `child_process` or shell out
- Any deserialization of user-controlled input

## Output

Either "✅ Security review passed — no issues" or a list of `<file>:<line> — <issue> — <fix>`.
