/**
 * Minimal preload for the quick-capture tray popover.
 * Exposes ONLY the two IPC calls this window needs.
 * The main preload (and all of window.api) is NOT available here.
 */
import { contextBridge, ipcRenderer } from 'electron'

type QuickCaptureKind = 'task' | 'note' | 'expense'

const quickCaptureApi = {
  submit: (kind: QuickCaptureKind, text: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('quick-capture:submit', kind, text),
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
  // Non-isolated fallback (dev only). `window` (DOM lib) has no typing for our
  // custom global, so widen it locally rather than suppressing the error.
  ;(window as typeof window & { quickCaptureApi: typeof quickCaptureApi }).quickCaptureApi =
    quickCaptureApi
}
