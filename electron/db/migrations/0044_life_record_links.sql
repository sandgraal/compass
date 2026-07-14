-- Life-record links (deferred from the vault split): tie a life record to the
-- domain rows it documents — the finance account behind a financial /
-- foreign-accounts record, the provider or agent contact behind a medical /
-- legal one. Mirrors document_links' generic (target_kind, target_id) shape.
-- Mirrored in ensureNewTables (the always-run fallback) like every schema
-- change, since packaged builds skip migrations.
CREATE TABLE `life_record_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`life_record_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` integer NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`life_record_id`) REFERENCES `life_records`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `life_record_links_unique` ON `life_record_links` (`life_record_id`,`target_kind`,`target_id`);
