CREATE TABLE `location_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`accuracy` real,
	`src` text NOT NULL,
	`dedup_hash` text NOT NULL,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_points_dedup_hash_unique` ON `location_points` (`dedup_hash`);