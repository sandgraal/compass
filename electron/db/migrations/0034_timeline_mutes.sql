-- Timeline memory mutes (Timeline 2.0 PR 6) — "never resurface this".
-- Mirrored in ensureNewTables (the always-run fallback) like every new table.
CREATE TABLE IF NOT EXISTS `timeline_mutes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`created_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `timeline_mutes_kind_target` ON `timeline_mutes` (`kind`,`target`);
