CREATE TABLE `linear_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`identifier` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`state_type` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`team` text,
	`due_date` text,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linear_issues_external_id_unique` ON `linear_issues` (`external_id`);