CREATE TABLE `simplefin_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` text NOT NULL,
	`org_name` text DEFAULT '' NOT NULL,
	`org_domain` text,
	`last_synced_at` integer,
	`error_code` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simplefin_connections_connection_id_unique` ON `simplefin_connections` (`connection_id`);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `simplefin_connection_id` integer REFERENCES simplefin_connections(id);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `simplefin_account_id` text;