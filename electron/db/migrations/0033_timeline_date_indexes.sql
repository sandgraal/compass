-- Timeline navigation indexes (hand-written; mirrored in ensureNewTables like
-- 0016's records indexes). (source|type, occurred_at) serve filtered
-- newest-first browse; the strftime expression indexes turn "on this day"
-- month-day matching and per-year histograms into index seeks.
CREATE INDEX IF NOT EXISTS `idx_records_source_occurred` ON `records` (`source`,`occurred_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_records_type_occurred` ON `records` (`type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_records_mmdd` ON `records` (strftime('%m-%d', `occurred_at` / 1000, 'unixepoch'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_records_year` ON `records` (CAST(strftime('%Y', `occurred_at` / 1000, 'unixepoch') AS INTEGER));
