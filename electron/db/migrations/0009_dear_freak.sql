CREATE TABLE `plaid_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`institution_id` text NOT NULL,
	`institution_name` text NOT NULL,
	`cursor` text,
	`last_synced_at` integer,
	`error_code` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plaid_items_item_id_unique` ON `plaid_items` (`item_id`);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `plaid_item_id` integer REFERENCES plaid_items(id);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `plaid_account_id` text;--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `mask` text;--> statement-breakpoint
CREATE INDEX `idx_finance_accounts_plaid` ON `finance_accounts` (`plaid_item_id`,`plaid_account_id`);