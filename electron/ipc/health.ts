/**
 * Health hub IPC (Phase 10.3). One read-only handler that returns the unified
 * health summary (`buildHealthSummary`) assembled from the already-ingested
 * `oura_daily_metrics` table + apple-health/fitbit/garmin `records`. Pure aggregate
 * — no raw rows leave beyond the short recent-workout list the page renders.
 */

import type { IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { buildHealthSummary } from '../integrations/health-summary'

export function registerHealthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('health:get-summary', () => buildHealthSummary(getRawSqlite(), Date.now()))
}
