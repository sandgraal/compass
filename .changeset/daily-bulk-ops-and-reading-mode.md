---
'compass': minor
---

Two bounded UX wins from the Phase 5 backlog:

- **Bulk operations in Daily checklist** — toggleable selection mode adds a leading checkbox to every row and a sticky toolbar showing the count. Batch actions: Complete, Reopen, Delete, Move to tomorrow. All four use the existing `checklist:update-item` / `delete-item` IPCs (the move-to-tomorrow path just updates `listDate`), so no schema or IPC surface change. Drag-handle is disabled while selecting to keep the two interaction models distinct.
- **Distraction-free reading mode** in the Knowledge Base — "Focus" button in the file header hides the sidebar + chrome and centers the editor with comfortable reading widths. Esc exits. The TipTap editor stays editable; this is a layout-only mode, not a read-only one.

No tests added — both features are layout/state glue exercised by smoke tests in the PR plan. 409/409 existing tests still green; typecheck clean; 0 Biome errors.
