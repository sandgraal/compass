CREATE TABLE `derived_entities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`match_key` text NOT NULL,
	`name` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`first_seen` integer,
	`last_seen` integer,
	`attrs` text,
	`promoted_kind` text,
	`promoted_id` integer,
	`refreshed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `derived_entities_kind_key` ON `derived_entities` (`kind`,`match_key`);--> statement-breakpoint
CREATE INDEX `derived_entities_kind_count` ON `derived_entities` (`kind`,`count`);
