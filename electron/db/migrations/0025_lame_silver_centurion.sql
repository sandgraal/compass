CREATE TABLE `rental_comps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`zone` text DEFAULT 'Cartago' NOT NULL,
	`bedrooms` integer DEFAULT 2 NOT NULL,
	`nightly_usd` real,
	`occupancy_pct` real,
	`rating` real,
	`review_count` integer,
	`notes` text,
	`saved_at` text,
	`created_at` integer,
	`updated_at` integer
);
