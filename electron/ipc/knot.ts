/**
 * Knot IPC (Phase 10.9). Separate from `auth.ts` because the Knot integration imports
 * `auth.ts` (`loadToken`/`saveToken`) — this avoids an import cycle. Data sync runs
 * through the generic `sync:trigger('knot')` path. Managed-only (no BYO).
 */

import { BrowserWindow, type IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { openKnotConnect } from '../integrations/knot'

export function registerKnotHandlers(ipcMain: IpcMain): void {
  // Open the Knot connect flow (SDK session minted via the relay) and store the
  // connected merchant id(s) to sync.
  ipcMain.handle('knot:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openKnotConnect(getRawSqlite(), win)
  })
}
