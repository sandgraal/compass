CREATE TABLE `travel_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`country` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer
);
