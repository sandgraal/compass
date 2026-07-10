-- Curation exclusions: the durable "no" list for contacts & derived entities
-- (tombstoned contacts, dedupe merge losers, "not interested" people/merchants/
-- places, dismissed duplicate pairs). Mirrored in ensureNewTables (the always-run
-- fallback) like every new table.
CREATE TABLE IF NOT EXISTS `curation_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `curation_exclusions_kind_target` ON `curation_exclusions` (`kind`,`target`);