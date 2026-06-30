CREATE TABLE `financial_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`target_amount` real DEFAULT 0 NOT NULL,
	`target_date` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`manual_current` real DEFAULT 0 NOT NULL,
	`monthly_contribution` real DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` integer,
	`updated_at` integer
);
