-- "Import full history" backfill for SimpleFIN connections: track how far
-- back a one-time backfill run has successfully paged (historyOldestDate, ISO
-- 'YYYY-MM-DD') and how its most recent run ended (historyBackfillStatus:
-- 'complete' | 'partial' | 'error' | null = never run), so a re-run resumes
-- further back instead of restarting from now. Mirrored in ensureNewTables /
-- createTablesIfNeeded (the always-run fallbacks) like every schema change,
-- since packaged builds skip migrations.
ALTER TABLE `simplefin_connections` ADD `history_oldest_date` text;
--> statement-breakpoint
ALTER TABLE `simplefin_connections` ADD `history_backfill_status` text;
