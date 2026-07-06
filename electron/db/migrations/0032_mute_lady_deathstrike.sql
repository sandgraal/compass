CREATE TABLE `medical_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`code` text,
	`status` text,
	`recorded_at` text,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `medical_records_external_id_unique` ON `medical_records` (`external_id`);