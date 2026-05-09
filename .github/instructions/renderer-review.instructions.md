---
applyTo: "src/**/*.ts,src/**/*.tsx"
---

Renderer review focus:

- Keep all Electron or Node access behind `window.api`; if a preload API changes, update `src/types/electron.d.ts` in the same PR.
- Prefer strict TypeScript, function components, and existing toast / confirm patterns. Do not introduce new `alert()`, `confirm()`, or `prompt()` calls.
- Accessibility matters on every UI diff: icon-only buttons need `aria-label`; form controls need visible labels or `aria-labelledby`; clickable non-button elements need a semantic role plus keyboard handlers; focus styles must stay visible; action buttons inside forms should declare `type="button"` unless they submit.
- Missing loading, empty, or error states are important when the changed flow performs async work.
- Flag raw hex colors or ad-hoc styling when existing semantic tokens such as `bg-card`, `text-foreground`, `border-border`, or `text-muted-foreground` should be used instead.
- Do not nitpick harmless markup churn unless it affects accessibility, behavior, or consistency with established patterns.
