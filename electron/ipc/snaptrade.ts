/**
 * SnapTrade IPC (Phase 10.9). Separate from `auth.ts` because the SnapTrade integration
 * imports `auth.ts` (`loadToken`/`saveToken`) — this avoids an import cycle. BYO-direct
 * (no relay): the user supplies their own SnapTrade partner credentials, stored encrypted.
 * Data sync runs through the generic `sync:trigger('snaptrade')` path.
 */

import { eq } from 'drizzle-orm'
import { BrowserWindow, type IpcMain } from 'electron'
import { getDb } from '../db/client'
import { integrations } from '../db/schema'
import {
  clearSnaptradeConnection,
  hasSnaptradeCreds,
  openSnaptradeConnect,
  setSnaptradeByoCreds
} from '../integrations/snaptrade'

export function registerSnaptradeHandlers(ipcMain: IpcMain): void {
  // Store the user's own SnapTrade partner credentials (clientId + consumerKey).
  ipcMain.handle('snaptrade:set-byo', (_event, clientId: unknown, consumerKey: unknown) => {
    if (
      typeof clientId !== 'string' ||
      typeof consumerKey !== 'string' ||
      !clientId.trim() ||
      !consumerKey.trim()
    ) {
      return { success: false, error: 'Both a SnapTrade clientId and consumerKey are required.' }
    }
    setSnaptradeByoCreds(clientId, consumerKey)
    return { success: true }
  })

  // Lets the UI decide whether to prompt for credentials or open the portal.
  ipcMain.handle('snaptrade:has-creds', () => hasSnaptradeCreds())

  // Open the SnapTrade Connection Portal (registers the user + mints the login URL).
  ipcMain.handle('snaptrade:connect', () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return openSnaptradeConnect(win)
  })

  // Forget the connected user (userId/userSecret) but keep the partner
  // clientId/consumerKey, so reconnecting doesn't force re-entering BYO
  // creds — unlike falling through to the generic auth:disconnect, which
  // would wipe the whole token blob.
  ipcMain.handle('snaptrade:disconnect', (): { success: true } => {
    clearSnaptradeConnection()
    getDb()
      .update(integrations)
      .set({ status: 'disconnected', lastSyncedAt: null })
      .where(eq(integrations.service, 'snaptrade'))
      .run()
    return { success: true }
  })
}
