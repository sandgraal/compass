CREATE TABLE `records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer,
	`title` text NOT NULL,
	`body` text,
	`payload` text,
	`dedup_hash` text NOT NULL,
	`provenance` text,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_dedup_hash_unique` ON `records` (`dedup_hash`);--> statement-breakpoint
CREATE INDEX `idx_records_occurred_at` ON `records` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_records_source_type` ON `records` (`source`,`type`);