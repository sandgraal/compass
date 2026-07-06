/**
 * Medical IPC (Phase 10.9 — "Metriport → medical records"). Mirrors `health.ts`:
 * `medical:get-summary` returns the aggregates for the Medical card, and `metriport:connect`
 * onboards the patient via the relay. Separate from `auth.ts` (the Metriport integration
 * imports `auth.ts`) to avoid an import cycle. Sync runs through `sync:trigger('metriport')`.
 */

import type { IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { buildMedicalSummary } from '../integrations/medical-summary'
import { openMetriportConnect } from '../integrations/metriport'

export function registerMedicalHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('medical:get-summary', () => buildMedicalSummary(getRawSqlite(), Date.now()))
  // Onboard the patient with Metriport (no consent widget — a pair of relay-fronted API calls).
  ipcMain.handle('metriport:connect', () => openMetriportConnect(getRawSqlite()))
}
