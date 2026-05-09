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
  type IpcMain,
  Menu,
  Tray,
  ipcMain as _ipcMain,
  app,
  globalShortcut,
  nativeImage,
  screen
} from 'electron'
import { getDb } from './db/client'
import { appSettings } from './db/schema'

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

let tray: Tray | null = null
let captureWindow: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------

function createTray(__dirname: string): Tray {
  const iconPath = join(__dirname, '../../resources/tray-icon.png')
  const img = nativeImage.createFromPath(iconPath)
  img.setTemplateImage(true)

  const t = new Tray(img)
  t.setToolTip('Compass — quick capture')

  // Build a context menu for right-click
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Quick add task', click: () => toggleCaptureWindow(t) },
    { type: 'separator' },
    {
      label: 'Open Compass',
      click: () => {
        const wins = BrowserWindow.getAllWindows().filter((w) => w !== captureWindow)
        if (wins.length > 0) {
          wins[0].show()
          wins[0].focus()
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
    height: 80,
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
    // Dev server serves from root; quick-capture has its own entry
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/quickCapture/index.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/quick-capture.html'))
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
  const { height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const winW = 360
  const winH = 80

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winW / 2)
  // macOS: menu bar is at top; position window below tray icon
  let y = Math.round(trayBounds.y + trayBounds.height + 4)

  // Ensure we don't fall off the right edge
  const displayWidth = screen.getPrimaryDisplay().bounds.width
  if (x + winW > displayWidth) x = displayWidth - winW - 4
  if (x < 0) x = 4

  // Edge case: if tray is at bottom (Linux/Windows) push window above
  if (y + winH > screenH) {
    y = Math.round(trayBounds.y - winH - 4)
  }

  captureWindow.setPosition(x, y, false)
  captureWindow.show()
  captureWindow.focus()
  captureWindow.webContents.send('quick-capture:focus')
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
  } catch {
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
  _ipcMain.on('quick-capture:hide', () => {
    captureWindow?.hide()
  })
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export function initMenuBar(__dirname: string, _ipcMainArg: IpcMain): void {
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
