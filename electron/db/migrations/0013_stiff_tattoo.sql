CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`cadence` text DEFAULT 'monthly' NOT NULL,
	`category` text,
	`status` text DEFAULT 'active' NOT NULL,
	`next_renewal` text,
	`payment_account` text,
	`cancel_url` text,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_external_id_unique` ON `subscriptions` (`external_id`);