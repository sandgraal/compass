---
'compass': patch
---

Fix `calendar:get-events` so Apple Calendar rows actually surface in the Dashboard / Daily / Weekly views. PR #74's Apple Calendar sync wrote rows with `source: 'apple'`, but the renderer-facing query was still hard-coded to `where(eq(source, 'google'))` — the events landed in the DB and were invisible. Switched to `inArray(source, ['google', 'apple'])`, which keeps the surface explicit so future sources have to opt-in here rather than dashboard pages seeing every third-party row by default.
