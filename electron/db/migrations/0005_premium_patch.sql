ALTER TABLE `finance_transactions` ADD `tax_tag` text DEFAULT 'tax:none' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `tax_tag_source` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `tax_year` integer;--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_tax_year_tag` ON `finance_transactions` (`tax_year`,`tax_tag`);--> statement-breakpoint
UPDATE `finance_transactions` SET `tax_year` = CAST(SUBSTR(`date`, 1, 4) AS INTEGER) WHERE `tax_year` IS NULL;