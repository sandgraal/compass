CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`name` text NOT NULL,
	`value` real,
	`provider` text,
	`reference` text,
	`renewal_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_external_id_unique` ON `assets` (`external_id`);