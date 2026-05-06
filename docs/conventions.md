# Compass — Coding Conventions

## TypeScript / React

- **Strict TypeScript.** No `any` unless interfacing with untyped third-party code (and then narrow it immediately).
- **Function components only.** No class components.
- **Named exports for components**, default export only for page-level components (matches React Router conventions).
- **Hooks at top of component**; never inside conditionals.
- **No `useEffect` for derived state.** Compute it inline.
- **Destructure props at the signature**, with explicit types.
- **`JSX.Element` return type** on every component (consistent across the codebase).

## File naming

- React components: `PascalCase.tsx` (e.g. `CommandPalette.tsx`)
- Hooks: `useFooBar.ts`
- Utilities: `kebab-case.ts` (e.g. `format-date.ts`)
- IPC modules: `electron/ipc/<domain>.ts` (lowercase)
- Tests: colocated as `*.test.ts` or `*.test.tsx`

## IPC handler pattern

A new IPC handler always touches **three files**:

1. **Handler in `electron/ipc/<domain>.ts`**:
   ```ts
   ipcMain.handle('<domain>:<verb>', (_event, ...args) => { /* ... */ })
   ```
   - Validate inputs (path traversal, type checks)
   - Wrap I/O errors and return `{ success: boolean, error?: string }`

2. **Expose in `electron/preload.ts`** under the appropriate namespace:
   ```ts
   <domain>: {
     <verb>: (arg) => ipcRenderer.invoke('<domain>:<verb>', arg)
   }
   ```

3. **Type in `src/types/electron.d.ts`**:
   ```ts
   <domain>: {
     <verb>(arg: T): Promise<R>
   }
   ```

> **Future**: `electron-trpc` will collapse all three into a single Zod-typed router. Until then, drift between these three is the most common source of bugs (the dual `CommandPalette` was an instance of this).

## Path safety

Every IPC handler that touches a file path must:
```ts
if (!fullPath.startsWith(KNOWLEDGE_DIR)) throw new Error('Path traversal blocked')
```
Or use the existing `relativePath.includes('..')` guard. **Never trust input paths.**

## Toast / Confirm pattern (in progress — see Phase 1.4)

Today's mix of `alert()` / `confirm()` / inline toast is being unified.
- Future: `import { useToast } from '@/components/ui/toast'`
- Future: `import { ConfirmDialog } from '@/components/ui/confirm-dialog'`
- Old `alert()`/`confirm()` calls being migrated PR by PR.

## Styling

- **Tailwind utility classes only.** No CSS files (other than `index.css` for tokens).
- **Use semantic tokens** (`bg-card`, `text-foreground`, `border-border`) — never raw hex or `bg-zinc-900`.
- **shadcn/ui patterns** — Radix primitives wrapped with consistent classes via the `cn()` helper.
- **Lucide icons**, sized 11–16 typically.
- **Animations** via `tailwindcss-animate`; new keyframes go in `tailwind.config.ts`.

## State management

- **Local state first.** Lift only when two components need it.
- **Zustand for app-wide state** (theme, context drawer open) — see `src/store/appStore.ts`.
- **No Redux, no Jotai, no Recoil.** Don't add another store layer.

## Async patterns

- `async/await` everywhere; no `.then()` chains in new code.
- Always wrap IPC calls in try/catch when the failure mode matters.
- Debounce auto-save with `useDebounce(value, ms)` (see `src/hooks/useDebounce.ts`).

## Error handling

- IPC handlers catch all errors and return `{ success: false, error: String(err) }`.
- Renderer code handles `{ success: false }` with a toast (not `console.error`).
- Never silently swallow errors that have user impact.

## Security invariants (DO NOT BREAK)

- Vault key NEVER leaves OS Keychain except via `safeStorage.decryptString()` in main process
- OAuth tokens stored encrypted (same mechanism); never logged; never sent to renderer
- CSP in production blocks all remote scripts (`script-src 'self'`)
- Renderer can never `require('fs')` or similar — context isolation enforces this
- Vault page calls `setContentProtection(true)` on mount, `false` on unmount (blocks macOS screenshots)

## Tests

- **Vitest** for unit + integration. Place near the file under test as `*.test.ts`.
- **Playwright** for E2E. Specs live in `e2e/`.
- **No snapshot tests** (brittle for visual UI). Test behavior, not markup.

## Commits

Conventional commits enforced by Lefthook hint (not strict):
- `feat:` new user-facing capability
- `fix:` bug fix
- `chore:` infra, build, deps
- `docs:` docs only
- `refactor:` no behavior change
- `test:` tests only

Co-author Claude on every Claude-touched commit:
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## PR checklist

Every PR includes:
1. A `.changeset/<random-name>.md` describing the user-visible change
2. Passing `npm run typecheck && npm run check && npm test`
3. Test plan in PR description (manual steps to verify)
4. Screenshot/recording for any UI change
5. No new `alert()` or `confirm()` calls (use the unified primitives)
