/**
 * Arcadia IPC (Phase 10.9). Separate from `auth.ts` because the Arcadia integration
 * imports `auth.ts` (`loadToken`/`saveToken`) — this avoids an import cycle. Data sync
 * runs through the generic `sync:trigger('arcadia')` path. Managed-only (no BYO).
 */

import { BrowserWindow, type IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { openArcadiaConnect } from '../integrations/arcadia'

export function registerArcadiaHandlers(ipcMain: IpcMain): void {
  // Open the Arcadia Connect widget (session minted via the relay) and mark connected.
  ipcMain.handle('arcadia:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openArcadiaConnect(getRawSqlite(), win)
  })
}
