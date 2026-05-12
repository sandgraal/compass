CREATE TABLE `finance_balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`balance` real NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_finance_balance_snapshots_account_captured` ON `finance_balance_snapshots` (`account_id`,`captured_at`);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `asset_class` text DEFAULT 'spending' NOT NULL;--> statement-breakpoint
UPDATE `finance_accounts` SET `asset_class` = 'liability' WHERE `is_debt` = 1;--> statement-breakpoint
UPDATE `finance_accounts` SET `asset_class` = 'savings' WHERE `is_debt` = 0 AND `type` = 'savings';--> statement-breakpoint
UPDATE `finance_accounts` SET `asset_class` = 'retirement' WHERE `is_debt` = 0 AND `type` = 'investment';