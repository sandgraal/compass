---
applyTo: "electron/**/*.ts,electron/**/*.tsx"
---

Main-process and IPC review focus:

- Sensitive operations belong in main-process code, especially `electron/ipc/*`, not in the renderer.
- Validate untrusted input at IPC boundaries: block path traversal, bound user-controlled strings or files, and avoid `eval`, `Function`, or shell execution with user input.
- Vault keys and OAuth tokens stay in the main process, are encrypted with `safeStorage` before disk writes, and must never be logged or sent to the renderer.
- If an IPC or preload contract changes, keep `electron/preload.ts` and `src/types/electron.d.ts` in sync in the same PR.
- Preserve BrowserWindow security defaults such as `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, and denying unexpected child windows.
- Do not flag legitimate local-only disk I/O inside Compass data directories when it follows the existing path-guard and encryption patterns.
