/**
 * macOS menu-bar tray + quick-capture popover.
 *
 * Responsibilities:
 *  - Create and manage the Tray icon
 *  - Toggle a frameless BrowserWindow (the quick-capture popover) on click
 *  - Register (and clean up) the global shortcut
 */
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { eq } from 'drizzle-orm'
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen
} from 'electron'
import { getDb } from './db/client'
import { appSettings } from './db/schema'
import { getQuickCaptureHtmlPath, getQuickCaptureHtmlUrl } from './quick-capture-path'

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

let tray: Tray | null = null
let captureWindow: BrowserWindow | null = null

export type RestartQuickCaptureShortcutResult =
  | { success: true }
  | {
      success: false
      reason: 'unsupported_platform' | 'tray_unavailable' | 'register_failed'
    }

const FALLBACK_TRAY_ICON_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <path
      fill="black"
      d="M8 1.25 10.1 5.9 14.75 8 10.1 10.1 8 14.75 5.9 10.1 1.25 8 5.9 5.9 8 1.25Zm0 2.73L6.95 6.95 3.98 8l2.97 1.05L8 12.02l1.05-2.97L12.02 8 9.05 6.95 8 3.98Z"
    />
  </svg>
`.trim()

function createTrayImage(__dirname: string) {
  const iconPaths = [
    join(__dirname, '../../resources/tray-icon.png'),
    join(__dirname, '../resources/tray-icon.png'),
    join(process.resourcesPath, 'tray-icon.png')
  ]

  for (const iconPath of iconPaths) {
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) {
      img.setTemplateImage(true)
      return img
    }
  }

  const fallbackImg = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(FALLBACK_TRAY_ICON_SVG).toString('base64')}`
  )
  fallbackImg.setTemplateImage(true)
  return fallbackImg
}

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------

function createTray(__dirname: string): Tray {
  const img = createTrayImage(__dirname)

  const t = new Tray(img)
  t.setToolTip('Compass — quick capture')

  // Build a context menu for right-click
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Quick capture', click: () => toggleCaptureWindow(t) },
    { type: 'separator' },
    {
      label: 'Open Compass',
      click: () => {
        const wins = BrowserWindow.getAllWindows().filter((w) => w !== captureWindow)
        if (wins.length > 0) {
          wins[0].show()
          wins[0].focus()
        } else {
          app.emit('activate')
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  t.setContextMenu(contextMenu)

  // Left-click toggles the capture popover
  t.on('click', () => toggleCaptureWindow(t))

  return t
}

// ---------------------------------------------------------------------------
// Quick-capture popover window
// ---------------------------------------------------------------------------

function createCaptureWindow(__dirname: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Do NOT set type: 'panel' — that breaks focus on macOS
    webPreferences: {
      preload: join(__dirname, '../preload/quick-capture.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Hide when the window loses focus (click-outside behaviour)
  win.on('blur', () => {
    win.hide()
  })

  // Prevent the Dock from showing a badge/icon for this window
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility?.(false)
  }

  // Load the quick-capture renderer
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(getQuickCaptureHtmlUrl(process.env.ELECTRON_RENDERER_URL))
  } else {
    win.loadFile(getQuickCaptureHtmlPath(__dirname))
  }

  return win
}

// ---------------------------------------------------------------------------
// Toggle logic
// ---------------------------------------------------------------------------

export function toggleCaptureWindow(t: Tray): void {
  if (!captureWindow) return

  if (captureWindow.isVisible()) {
    captureWindow.hide()
    return
  }

  // Position directly below the tray icon
  const trayBounds = t.getBounds()
  const trayDisplay = screen.getDisplayMatching(trayBounds)
  const { x: workAreaX, y: workAreaY, width: workAreaW, height: workAreaH } = trayDisplay.workArea
  const winW = 360
  const winH = 120

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winW / 2)
  // macOS: menu bar is at top; position window below tray icon
  let y = Math.round(trayBounds.y + trayBounds.height + 4)

  // Ensure we don't fall off display edges
  const minX = workAreaX + 4
  const maxX = workAreaX + workAreaW - winW - 4
  x = Math.max(minX, Math.min(x, maxX))

  // Edge case: if tray is at bottom (Linux/Windows) push window above
  if (y + winH > workAreaY + workAreaH) {
    y = Math.round(trayBounds.y - winH - 4)
  }
  if (y < workAreaY) y = workAreaY + 4

  captureWindow.setPosition(x, y, false)
  captureWindow.show()
  captureWindow.focus()
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------

function loadShortcut(): string {
  try {
    const db = getDb()
    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'quickCaptureShortcut'))
      .get()
    return (row?.value as string | undefined) ?? DEFAULT_SHORTCUT
  } catch (err) {
    console.warn('[menu-bar] read quickCaptureShortcut failed; using default', err)
    return DEFAULT_SHORTCUT
  }
}

function registerShortcut(chord: string): void {
  try {
    const registered = globalShortcut.register(chord, () => {
      if (tray) toggleCaptureWindow(tray)
    })
    if (!registered) {
      console.warn(
        `[menu-bar] Could not register global shortcut "${chord}" — already in use by another app`
      )
    }
  } catch (err) {
    console.error('[menu-bar] globalShortcut.register error:', err)
  }
}

// ---------------------------------------------------------------------------
// IPC: hide request from renderer
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.on('quick-capture:hide', () => {
    captureWindow?.hide()
  })
}

// ---------------------------------------------------------------------------
// Public: re-register shortcut (called by settings IPC handler)
// ---------------------------------------------------------------------------

/**
 * Unregisters the current global shortcut and registers the new one.
 * Returns a structured success/failure result so callers can show a specific
 * error message for unsupported platform/tray state vs registration conflicts.
 * Quick Capture shortcut management is currently macOS-only.
 */
function tryRegisterShortcut(chord: string): boolean {
  try {
    return globalShortcut.register(chord, () => {
      if (tray) toggleCaptureWindow(tray)
    })
  } catch (err) {
    console.warn('[menu-bar] globalShortcut.register failed', chord, err)
    return false
  }
}

export function restartQuickCaptureShortcut(newChord: string): RestartQuickCaptureShortcutResult {
  if (process.platform !== 'darwin') {
    return { success: false, reason: 'unsupported_platform' }
  }

  if (!tray) {
    return { success: false, reason: 'tray_unavailable' }
  }

  // Unregister whatever is currently active
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    console.warn('[menu-bar] globalShortcut.unregisterAll failed', err)
  }

  if (tryRegisterShortcut(newChord)) {
    return { success: true }
  }

  // Registration failed — fall back to previous shortcut loaded from DB
  const fallback = loadShortcut()
  if (fallback !== newChord) {
    tryRegisterShortcut(fallback)
  }

  return { success: false, reason: 'register_failed' }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export function initMenuBar(__dirname: string): void {
  if (process.platform !== 'darwin') {
    // Tray works on all platforms but the spec is macOS-only; guard to keep
    // this safe on Linux/Windows CI where display servers may be absent.
    // You can remove this guard if cross-platform tray support is desired later.
    return
  }

  tray = createTray(__dirname)
  captureWindow = createCaptureWindow(__dirname)

  registerIpc()

  const chord = loadShortcut()
  registerShortcut(chord)

  // Expose clean-up to app lifecycle
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
