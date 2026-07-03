CREATE TABLE `oura_daily_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`sleep_score` integer,
	`readiness_score` integer,
	`activity_score` integer,
	`steps` integer,
	`total_sleep_minutes` integer,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oura_daily_metrics_date_unique` ON `oura_daily_metrics` (`date`);