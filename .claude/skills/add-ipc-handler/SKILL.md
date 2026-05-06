---
name: add-ipc-handler
description: Adds a new IPC handler with the canonical three-file pattern (handler in electron/ipc/, expose in preload.ts, type in src/types/electron.d.ts). Auto-loads when the user asks to add a new IPC, expose a backend function to the renderer, or wire up window.api.
---

# Adding an IPC handler

Every IPC handler touches **three files** in lockstep. Drift between them is the leading source of bugs.

## Step 1 — Handler (`electron/ipc/<domain>.ts`)

Pick or create the right module:
- `auth.ts` — anything OAuth or token-related
- `sync.ts` — sync triggers + status + log
- `knowledge.ts` — markdown file CRUD
- `vault.ts` — encrypted entries
- `settings.ts` — key/value config + checklist + data export/wipe
- `finance.ts` — finance entities
- `habits.ts` — habit tracking
- New domain → new file `electron/ipc/<domain>.ts` + `register<Domain>Handlers(ipcMain)` + add to `electron/main.ts`

Pattern:
```typescript
ipcMain.handle('<domain>:<verb>', (_event, arg1: T1, arg2: T2) => {
  // 1. Validate inputs (path traversal, type checks, length bounds)
  if (typeof arg1 !== 'string' || arg1.includes('..')) throw new Error('invalid input')

  // 2. Do the work
  const db = getDb()
  const result = db.select().from(<table>).where(...).all()

  // 3. Return — for fallible operations, prefer { success: boolean, error?: string }
  return result
})
```

Conventions:
- Verb-style names: `get`, `set`, `add`, `update`, `delete`, `list`, `search`, `trigger`
- Synchronous DB calls are fine (better-sqlite3 is sync)
- Catch and wrap errors that can affect the user; let programming errors throw

## Step 2 — Expose in `electron/preload.ts`

Find or create the namespace under `api.<domain>`:
```typescript
<domain>: {
  // existing entries...
  <verb>: (arg1: T1, arg2: T2) => ipcRenderer.invoke('<domain>:<verb>', arg1, arg2)
}
```

## Step 3 — Type in `src/types/electron.d.ts`

Inside `Window.api`, find the `<domain>` block and add:
```typescript
<domain>: {
  // existing entries...
  <verb>(arg1: T1, arg2: T2): Promise<R>
}
```

## Verify

```bash
npx tsc --noEmit                         # renderer
npx tsc -p tsconfig.node.json --noEmit   # main
```

If renderer code calls `window.api.<domain>.<verb>(...)` with wrong types, the renderer typecheck will fail.

## Hard rules

- **All three files in the same PR.** Don't ship a handler without exposure or types — agents (and humans) will assume it's broken.
- **Match existing patterns.** Look at how `vault:add-entry` or `checklist:add-item` is wired and follow that style.
- **Validate inputs.** Especially file paths (traversal), strings (length), numbers (range).
- **Return errors as data**, not as thrown exceptions, when the failure is part of normal flow (e.g. "user canceled dialog"). Throw only for true programming errors.

## Migrating to electron-trpc (planned)

When `electron-trpc` is adopted in Phase 0.7, this 3-file dance collapses to ONE file with Zod schemas. Until then, this skill is the canonical pattern.
