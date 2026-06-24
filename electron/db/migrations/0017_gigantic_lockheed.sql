CREATE TABLE `snapshot_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`category` text NOT NULL,
	`label` text,
	`value` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`dedup_hash` text NOT NULL,
	`provenance` text,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_facts_dedup_hash_unique` ON `snapshot_facts` (`dedup_hash`);