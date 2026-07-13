CREATE TABLE `lab_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_name` text NOT NULL,
	`panel` text,
	`value` real,
	`value_text` text,
	`unit` text,
	`ref_range` text,
	`flag` text,
	`taken_at` text NOT NULL,
	`encounter_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`notes` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `lab_results_test_name_taken_at` ON `lab_results` (`test_name`,`taken_at`);