-- Merchants redesign (tracked-merchant profiles): persist the normalized
-- merchant key on every finance transaction so profiles/stats/MCP can GROUP BY
-- in SQL (normalizeMerchant is a JS function — see electron/lib/normalize.ts,
-- whose output is a frozen contract), plus a namespaced JSON `meta` column on
-- places (support contacts now; web enrichment later — mirrors
-- contacts.enrichment from 0035). Mirrored in ensureNewTables (the always-run
-- fallback) like every schema change, since packaged builds skip migrations.
ALTER TABLE `finance_transactions` ADD `normalized_merchant` text;
--> statement-breakpoint
ALTER TABLE `places` ADD `meta` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_finance_transactions_normalized_merchant` ON `finance_transactions` (`normalized_merchant`);
