CREATE TABLE `place_merge_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`survivor_place_id` integer NOT NULL,
	`kind` text NOT NULL,
	`alias_key` text NOT NULL,
	`alias_name` text,
	`created_at` integer,
	FOREIGN KEY (`survivor_place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `place_merge_aliases_kind_alias_unique` ON `place_merge_aliases` (`kind`,`alias_key`);--> statement-breakpoint
CREATE INDEX `place_merge_aliases_survivor` ON `place_merge_aliases` (`survivor_place_id`);