CREATE TABLE `life_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`fields` text,
	`notes` text,
	`has_secrets` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `life_records_external_id_unique` ON `life_records` (`external_id`);