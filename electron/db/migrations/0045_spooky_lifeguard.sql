-- Subscriptions redesign (2026-07): trial-end tracking + namespaced JSON meta
-- (usage self-check-in now; web enrichment reserved for later — mirrors
-- `places.meta` from the merchants redesign, migration 0041). Mirrored in
-- ensureNewTables (the always-run fallback) like every schema change, since
-- packaged builds skip migrations.
--
-- Note: `drizzle-kit generate` also proposed re-creating `life_record_links`
-- here because migration 0044 was hand-authored without a matching
-- `meta/0044_snapshot.json` (that snapshot file was never generated), so
-- drizzle's last-known state still predated 0044. That CREATE TABLE has been
-- removed from this file — 0044 already created the table on any DB that has
-- run it, and re-running it would error. `meta/0045_snapshot.json` (this
-- migration's generated snapshot) captures the full current schema including
-- `life_record_links`, so the diff chain is self-healing from here forward.
ALTER TABLE `subscriptions` ADD `trial_ends_at` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `meta` text;
