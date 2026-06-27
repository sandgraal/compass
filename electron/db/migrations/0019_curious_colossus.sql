ALTER TABLE `finance_accounts` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`rate` real NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`fetched_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_fx_rates_date_base_quote` ON `fx_rates` (`date`,`base`,`quote`);
