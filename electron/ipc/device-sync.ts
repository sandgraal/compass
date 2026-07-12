/**
 * Device-sync IPC (Phase 4b) — thin validated boundary over
 * `electron/integrations/device-sync.ts`. The pull is a destructive full
 * replace (snapshot + last-writer-wins), so the renderer gates it behind an
 * explicit confirm; this layer only validates inputs and forwards.
 */
import type { IpcMain } from 'electron'
import {
  checkRemote,
  configureDeviceSync,
  disableDeviceSync,
  getDeviceSyncStatus,
  pullSnapshot,
  pushSnapshot
} from '../integrations/device-sync'

export function registerDeviceSyncHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('device-sync:status', () => getDeviceSyncStatus())

  ipcMain.handle('device-sync:configure', (_e, passphrase: unknown) => {
    if (typeof passphrase !== 'string') {
      return { success: false as const, error: 'Passphrase is required' }
    }
    return configureDeviceSync(passphrase)
  })

  ipcMain.handle('device-sync:disable', () => disableDeviceSync())

  ipcMain.handle('device-sync:check', () => checkRemote())

  ipcMain.handle('device-sync:push', () => pushSnapshot())

  ipcMain.handle('device-sync:pull', () => pullSnapshot())
}
