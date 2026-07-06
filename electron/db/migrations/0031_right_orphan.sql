CREATE TABLE `utility_bills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`provider` text,
	`service_address` text,
	`statement_date` text,
	`period_start` text,
	`period_end` text,
	`amount` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`usage_kwh` real,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `utility_bills_external_id_unique` ON `utility_bills` (`external_id`);