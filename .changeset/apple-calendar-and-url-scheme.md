---
'compass': minor
---

Two strategic-review Tier 3 items (closing the most embarrassing gaps for a Mac-only app):

- **Apple Calendar (iCal) local read** — Compass now reads `~/Library/Calendars/*.calendar/Events/*.ics` directly: no OAuth, no network, no extra permission prompt beyond Full Disk Access for the parent Electron app. Events show up in the same `calendar_events` table the Google sync writes to (`source: 'apple'`), so every Dashboard / Daily / Weekly surface that already lists upcoming events picks them up for free. New Integrations card with a one-click "Connect" that just runs the local sync. Limitations: RRULE expansion is a follow-up (base instance is emitted today); TZID bodies parse as floating local time.
- **`compass://` URL scheme** — `app.setAsDefaultProtocolClient('compass')` plus a small command vocabulary so Apple Shortcuts, Raycast, the macOS Services menu, and other apps can drive Compass:
  - `compass://capture?text=…&category=…` → quick-add to today's daily checklist
  - `compass://open/<page>` → navigate to a top-level page (whitelisted)
  - `compass://search?q=…` → open the ⌘K palette pre-filled
  Single-instance lock ensures a second `compass://` click routes into the already-running process via `second-instance`. Packaged macOS app registers the scheme on install via `electron-builder.protocols`.

33 new unit tests cover the ICS parser (folding, escapes, DATE vs DATE-TIME, multi-event files, RRULE flagging, window filtering, plist title extraction) and the URL-scheme parser (every command shape, argv scan, unknown rejects).
