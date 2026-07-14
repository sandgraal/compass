-- Places geo-correlation (PlaceMeta.geo): index raw GPS points by time so the
-- per-visit ±2h window queries that derive a tracked place's approximate
-- coordinate are indexed range scans, not full scans over the whole location
-- history. Mirrored in ensureNewTables (the always-run fallback) like every
-- schema change, since packaged builds skip migrations.
CREATE INDEX IF NOT EXISTS `idx_location_points_occurred_at` ON `location_points` (`occurred_at`);
