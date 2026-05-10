---
"compass": minor
---

feat: calendar contact proposals + finance subfolder institution hints

- Knowledge suggest-edit now includes a `calendar` source extractor. Attendee emails
  found in Google Calendar event descriptions are aggregated across the last 30 days;
  anyone appearing in 2 or more events who is not already in `profile/relationships.md`
  is proposed as a new contact row.

- Finance folder watcher now uses the immediate parent directory name as an institution
  hint when the filename alone is ambiguous. Placing a generic statement PDF inside
  `~/Documents/Money/USAA/` or `~/Documents/Money/Chase/` is now enough for Compass to
  detect the correct institution — no need to rename the file.
