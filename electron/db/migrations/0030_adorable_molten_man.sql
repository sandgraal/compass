CREATE TABLE `argyle_paystubs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`employer` text,
	`gross_pay` real,
	`net_pay` real,
	`withholding` real,
	`deductions` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`period_start` text,
	`period_end` text,
	`paid_at` text,
	`pay_cycle` text,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `argyle_paystubs_external_id_unique` ON `argyle_paystubs` (`external_id`);