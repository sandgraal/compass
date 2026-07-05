/**
 * Terra IPC (Phase 10.9). Kept out of `auth.ts` because the Terra integration
 * imports `auth.ts` (`loadToken`/`saveToken`) — registering the handlers here avoids
 * an import cycle. Data sync goes through the generic `sync:trigger('terra')` path.
 */

import { BrowserWindow, type IpcMain } from 'electron'
import { getRawSqlite } from '../db/client'
import { openTerraConnect, setTerraByoCreds } from '../integrations/terra'

export function registerTerraHandlers(ipcMain: IpcMain): void {
  // Open the Terra Connect widget (session minted via the relay) and store the user_id.
  ipcMain.handle('terra:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openTerraConnect(getRawSqlite(), win)
  })

  // BYO: the user supplies their own Terra dev credentials → direct-to-upstream mode.
  ipcMain.handle('terra:set-byo', (_event, devId: unknown, apiKey: unknown) => {
    if (
      typeof devId !== 'string' ||
      typeof apiKey !== 'string' ||
      !devId.trim() ||
      !apiKey.trim()
    ) {
      return { success: false, error: 'Both a Terra dev-id and x-api-key are required.' }
    }
    setTerraByoCreds(devId, apiKey)
    return { success: true }
  })
}
