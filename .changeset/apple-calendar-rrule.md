---
'compass': minor
---

**Apple Calendar RRULE expansion** — the promised follow-up from PR #74. The first-cut sync only emitted a single base instance for each recurring event; now `electron/integrations/apple-rrule.ts` materializes occurrences within the lookahead window for the common DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/BYDAY/EXDATE subset that covers ~95% of real-world Calendar.app rules.

- Pure in-house expander — no `rrule.js` dep — with a hard cap (default 366) and a recognised-but-unimplemented-token bag (BYSETPOS, BYMONTHDAY, etc.) so the long tail logs a warning instead of silently misbehaving.
- Each materialized occurrence gets a unique per-occurrence `uid` (`${baseUid}::${occurrenceISO}`) so the DB upsert in `syncAppleCalendar` keys correctly across days of the same recurring event.
- Per-occurrence duration is preserved from the base event's `DTEND - DTSTART` (or sensible defaults for events without an explicit end).
- EXDATE values are honoured — specific cancelled occurrences are removed from the materialized list.
- 28 new unit tests cover the parser (each token), the expander (daily/weekly/monthly/yearly + INTERVAL + COUNT + UNTIL + BYDAY + EXDATE + truncation + window clipping), and end-to-end iCal-file → materialized-events flow.

437/437 tests green, typecheck clean, 0 Biome errors.
