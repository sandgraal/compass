---
applyTo: "**"
---

Cross-cutting review guidance:

- Match the existing stack and patterns: Biome, Drizzle, Vitest, Playwright, TipTap, Tailwind tokens, Lucide, Zustand, and the preload bridge. Do not suggest swapping them out in routine reviews.
- New IPC work must include validation at the boundary, keep sensitive operations in the main process, and keep `electron/preload.ts` / `src/types/electron.d.ts` in sync.
- Schema changes in `electron/db/schema.ts` should come with the generated migration files and any required compatibility handling in `electron/db/client.ts`.
- Prefer shared primitives over native dialogs: new `alert()`, `confirm()`, or `prompt()` calls should be flagged in favor of `useToast()` and `useConfirm()`.

Do not raise standalone review findings for known warning-level cleanup on untouched code:

- Demoted Biome warnings such as `useExhaustiveDependencies`, `noAssignInExpressions`, `noArrayIndexKey`, `useButtonType`, `noLabelWithoutControl`, and `useKeyWithClickEvents`
- The documented `as any` escape hatch in `electron/ipc/finance.ts`
- Optional-dependency lockfile churn caused by platform-specific `npm install` behavior
- Dark-theme defaults or the intentional split between `tsconfig.web.json` and `tsconfig.node.json`
