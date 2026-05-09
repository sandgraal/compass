/**
 * Minimal preload for the quick-capture tray popover.
 * Exposes ONLY the two IPC calls this window needs.
 * The main preload (and all of window.api) is NOT available here.
 */
import { contextBridge, ipcRenderer } from 'electron'

const quickCaptureApi = {
  quickAdd: (title: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('checklist:quick-add', title),
  hide: (): void => {
    ipcRenderer.send('quick-capture:hide')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('quickCaptureApi', quickCaptureApi)
  } catch (error) {
    console.error('[quick-capture preload]', error)
  }
} else {
  // @ts-ignore
  window.quickCaptureApi = quickCaptureApi
}
