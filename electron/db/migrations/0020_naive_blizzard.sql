ALTER TABLE `finance_accounts` ADD `is_foreign` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `finance_accounts` SET `is_foreign` = 1 WHERE `currency` != 'USD';
