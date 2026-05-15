---
'compass': minor
---

Two bounded UX wins from the strategic-review backlog:

- **Vault auto-lock** — the Vault page now blurs/hides every entry behind an "Unlock" CTA after a configurable idle interval (default 5 minutes; 0 = disabled). Also locks immediately on window focus loss, so an unattended Mac stops showing secrets the moment another app takes focus. Activity tracker watches mouse, keyboard, scroll, and touch events. Header gets a manual "Lock" button. Settings → Security & Privacy adds a dropdown (Off / 1m / 2m / 5m / 10m / 15m / 30m / 1h). The vault entries stay encrypted at rest the whole time — auto-lock is a UI gate against shoulder surfing, complementing the existing `setContentProtection(true)`.
- **Habit streaks badges** — Monthly habits view shows a `🔥 N` flame badge next to each habit with an active streak (≥ 2 days). Tooltip includes the longest-ever streak. New pure helper `src/lib/habit-streaks.ts` computes current + longest from the existing `habits:get-entries` map; "today unchecked but yesterday checked" doesn't break the streak until end-of-yesterday. 10 unit tests cover boundaries (empty map, gaps, month-spanning runs, explicit false values, malformed date keys).

335/335 tests green, typecheck clean, 0 Biome errors.
