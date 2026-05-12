CREATE TABLE `forecast_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount` real,
	`label` text,
	`kind` text NOT NULL,
	`shift_to_date` text,
	`created_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_forecast_overrides_account_date` ON `forecast_overrides` (`account_id`,`date`);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `payment_day_of_month` integer;