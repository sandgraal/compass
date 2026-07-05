/**
 * Canopy IPC (Phase 10.9). Separate from `auth.ts` because the Canopy integration
 * imports `auth.ts` (`loadToken`/`saveToken`) — this avoids an import cycle. Data sync
 * runs through the generic `sync:trigger('canopy')` path. Managed-only (no BYO).
 */

import { BrowserWindow, type IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { openCanopyConnect } from '../integrations/canopy'

export function registerCanopyHandlers(ipcMain: IpcMain): void {
  // Open the Canopy Connect flow (session minted via the relay) and store the pull_id.
  ipcMain.handle('canopy:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openCanopyConnect(getRawSqlite(), win)
  })
}
