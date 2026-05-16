---
'compass': minor
---

**Spotlight-friendly knowledge mirror** — Phase 5.14. macOS doesn't index `~/Library/Application Support/` by default, so a phrase from a Compass note doesn't show up in Spotlight (or any third-party Spotlight client). This change adds an opt-in one-way mirror that copies `knowledge-base/*.md` to a user-chosen path under `~/Documents/` or `~/Desktop/` — both of which Spotlight already indexes.

- New `electron/integrations/spotlight-mirror.ts` — pure helpers: `isAllowedMirrorPath` (restricts targets to ~/Documents or ~/Desktop, the canonically Spotlight-indexed paths), `reconcileMirror` (mtime-skip backfill + stale-file prune + empty-dir cleanup), `applyMirrorChange` (per-event add/change/unlink for the watcher). 22 unit tests cover allowlist, backfill, prune, off-limits rejection, symlink defense, README write.
- New IPC handlers: `spotlight:get-status`, `spotlight:set-enabled`, `spotlight:set-path`, `spotlight:backfill-now` in `electron/ipc/spotlight.ts`.
- Watcher: piggybacks on chokidar against `KNOWLEDGE_DIR` with `awaitWriteFinish: { stabilityThreshold: 500 }` so partial saves don't trigger half-file copies.
- Mirror is **one-way** — edits to the mirrored copies are NOT synced back. A `README.txt` lands in the mirror dir on first backfill explaining this and pointing back at the source path.
- Settings → Data gets a "Spotlight indexing" toggle, mirror-path text field (validated), and a manual "Reconcile" button with last-run timestamp.

Defaults to off. 514/514 tests green, typecheck clean, 0 Biome errors.
