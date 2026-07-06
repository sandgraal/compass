/**
 * Nylas IPC (Phase 10.9). Separate from `auth.ts` because the Nylas integration imports
 * `auth.ts` (`loadToken`/`saveToken`) — this avoids an import cycle. Data sync runs through
 * the generic `sync:trigger('nylas')` path. Managed-only (no BYO).
 */

import { BrowserWindow, type IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { openNylasConnect } from '../integrations/nylas'

export function registerNylasHandlers(ipcMain: IpcMain): void {
  // Open Nylas Hosted Auth (session minted via the relay) and store the grant id.
  ipcMain.handle('nylas:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openNylasConnect(getRawSqlite(), win)
  })
}
