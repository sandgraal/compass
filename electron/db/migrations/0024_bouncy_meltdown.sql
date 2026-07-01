CREATE TABLE `places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`kind` text DEFAULT 'merchant' NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`address` text,
	`url` text,
	`total_spend` real,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `places_external_id_unique` ON `places` (`external_id`);