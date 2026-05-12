ALTER TABLE `finance_transactions` ADD `geo` text DEFAULT 'US' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `purpose` text;--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_geo` ON `finance_transactions` (`geo`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_geo_purpose` ON `finance_transactions` (`geo`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_geo_date` ON `finance_transactions` (`geo`,`date`);--> statement-breakpoint
UPDATE `finance_transactions` SET `geo` = 'CR' WHERE `notes` LIKE '%geo:CR%';--> statement-breakpoint
UPDATE `finance_transactions` SET `geo` = 'SPAIN' WHERE `notes` LIKE '%geo:SPAIN%';--> statement-breakpoint
UPDATE `finance_transactions` SET `geo` = 'COLOMBIA' WHERE `notes` LIKE '%geo:COLOMBIA%';--> statement-breakpoint
UPDATE `finance_transactions` SET `geo` = 'PANAMA' WHERE `notes` LIKE '%geo:PANAMA%';--> statement-breakpoint
UPDATE `finance_transactions` SET `geo` = 'OTHER' WHERE `notes` LIKE '%geo:OTHER%';--> statement-breakpoint
UPDATE `finance_transactions` SET `purpose` = 'capex' WHERE `notes` LIKE '%purpose:capex%';--> statement-breakpoint
UPDATE `finance_transactions` SET `purpose` = 'household' WHERE `notes` LIKE '%purpose:household%';--> statement-breakpoint
UPDATE `finance_transactions` SET `purpose` = 'operating' WHERE `notes` LIKE '%purpose:operating%';--> statement-breakpoint
UPDATE `finance_transactions` SET `purpose` = 'travel' WHERE `notes` LIKE '%purpose:travel%';--> statement-breakpoint
UPDATE `finance_transactions` SET `purpose` = 'other' WHERE `notes` LIKE '%purpose:other%';