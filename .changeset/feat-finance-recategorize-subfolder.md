---
"compass": minor
---

Finance: auto-recategorize existing transactions when rules change, and watch sub-folders up to 3 levels deep.

**Re-apply rules** — After saving or deleting a categorization rule, existing transactions are automatically re-categorized in the background. A manual "Re-apply to all" button in the Rules tab lets you trigger this on demand; it shows a toast with the count of updated transactions. Only rows where the computed category actually differs are written (idempotent).

**Sub-folder watching** — The finance folder watcher now scans and watches up to 3 levels of sub-folders (e.g. `~/Documents/Money/USAA/`, `~/Documents/Money/Amex/`). Files deeper than 3 levels are intentionally skipped as a performance guardrail.
