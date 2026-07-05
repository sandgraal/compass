/**
 * Argyle IPC (Phase 10.9). Separate from `auth.ts` because the Argyle integration
 * imports `auth.ts` (`loadToken`/`saveToken`) — this avoids an import cycle. Data sync
 * runs through the generic `sync:trigger('argyle')` path. Managed-only (no BYO).
 */

import { BrowserWindow, type IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { openArgyleConnect } from '../integrations/argyle'

export function registerArgyleHandlers(ipcMain: IpcMain): void {
  // Open the Argyle Link flow (session minted via the relay) and store the user id.
  ipcMain.handle('argyle:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openArgyleConnect(getRawSqlite(), win)
  })
}
