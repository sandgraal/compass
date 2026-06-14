CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`given_name` text,
	`family_name` text,
	`middle_name` text,
	`prefix` text,
	`suffix` text,
	`org` text,
	`job_title` text,
	`phones` text,
	`emails` text,
	`addresses` text,
	`birthday` text,
	`url` text,
	`relationship` text,
	`notes` text,
	`photo` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`search_blob` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_external_id_unique` ON `contacts` (`external_id`);