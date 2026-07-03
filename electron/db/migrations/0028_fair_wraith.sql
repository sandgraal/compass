ALTER TABLE `habit_entries` ADD `source` text;--> statement-breakpoint
ALTER TABLE `habits` ADD `auto_link_source` text;--> statement-breakpoint
ALTER TABLE `habits` ADD `auto_link_threshold` real;