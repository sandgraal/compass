-- Promote the (account_id, date) index on forecast_overrides to a UNIQUE
-- index keyed by (account_id, date, label). This enforces "at most one
-- override per (account, date, event-label)" at the DB level so the
-- set-forecast-override IPC can use INSERT … ON CONFLICT DO UPDATE for an
-- atomic upsert (instead of the racy DELETE + INSERT pair).
--
-- Drop the old non-unique index first; SQLite will use the new unique one
-- for the same lookup pattern.
DROP INDEX IF EXISTS `idx_forecast_overrides_account_date`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_forecast_overrides_account_date_label` ON `forecast_overrides` (`account_id`,`date`,`label`);
