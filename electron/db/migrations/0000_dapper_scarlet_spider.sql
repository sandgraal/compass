CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `budget_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`subcategory` text,
	`monthly_amount` real DEFAULT 0 NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`all_day` integer DEFAULT false,
	`location` text,
	`description` text,
	`html_link` text,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_external_id_unique` ON `calendar_events` (`external_id`);--> statement-breakpoint
CREATE TABLE `categorization_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`category` text NOT NULL,
	`subcategory` text,
	`priority` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `checklist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_type` text NOT NULL,
	`list_date` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`checked` integer DEFAULT false,
	`status` text DEFAULT 'unchecked',
	`category` text DEFAULT 'personal',
	`sort_order` integer DEFAULT 0,
	`due_date` text,
	`source` text DEFAULT 'manual',
	`source_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checklist_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_type` text NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_templates_list_type_unique` ON `checklist_templates` (`list_type`);--> statement-breakpoint
CREATE TABLE `drive_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`url` text,
	`summary` text,
	`last_modified` integer,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_files_external_id_unique` ON `drive_files` (`external_id`);--> statement-breakpoint
CREATE TABLE `finance_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'credit' NOT NULL,
	`is_debt` integer DEFAULT false,
	`balance` real DEFAULT 0,
	`apr` real DEFAULT 0,
	`min_payment` real DEFAULT 0,
	`credit_limit` real,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `finance_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hash` text NOT NULL,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`description` text NOT NULL,
	`account_id` integer,
	`category` text DEFAULT 'Uncategorized',
	`subcategory` text,
	`notes` text,
	`source_file` text,
	`ingested_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `finance_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_transactions_hash_unique` ON `finance_transactions` (`hash`);--> statement-breakpoint
CREATE TABLE `github_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`repo` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`body` text,
	`labels` text,
	`due_date` text,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_items_external_id_unique` ON `github_items` (`external_id`);--> statement-breakpoint
CREATE TABLE `gmail_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`subject` text NOT NULL,
	`from_address` text NOT NULL,
	`action_summary` text,
	`snippet` text,
	`received_at` integer,
	`snoozed_until` text,
	`done` integer DEFAULT false,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_actions_thread_id_unique` ON `gmail_actions` (`thread_id`);--> statement-breakpoint
CREATE TABLE `habit_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`habit_id` integer,
	`date` text NOT NULL,
	`completed` integer DEFAULT false,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `habits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`color` text DEFAULT '#6272f1',
	`active` integer DEFAULT true,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service` text NOT NULL,
	`connected_at` integer,
	`last_synced_at` integer,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`scopes` text,
	`error_message` text,
	`sync_interval_minutes` integer DEFAULT 15 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_service_unique` ON `integrations` (`service`);--> statement-breakpoint
CREATE TABLE `knowledge_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`last_modified` integer,
	`word_count` integer DEFAULT 0,
	`auto_updated` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_files_path_unique` ON `knowledge_files` (`path`);--> statement-breakpoint
CREATE TABLE `sync_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`integration_id` integer,
	`synced_at` integer NOT NULL,
	`records_updated` integer DEFAULT 0,
	`errors` text,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action
);
