import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Typed API exposed to the renderer via contextBridge
// The renderer has ZERO direct access to Node.js or Electron internals
const api = {
  // --- Auth ---
  auth: {
    connectGoogle: () => ipcRenderer.invoke('auth:connect-google'),
    connectGitHub: () => ipcRenderer.invoke('auth:connect-github'),
    disconnect: (service: string) => ipcRenderer.invoke('auth:disconnect', service),
    getStatus: () => ipcRenderer.invoke('auth:get-status'),
    getRedirectUris: () => ipcRenderer.invoke('auth:get-redirect-uris')
  },

  // --- Sync ---
  sync: {
    triggerSync: (service: string) => ipcRenderer.invoke('sync:trigger', service),
    triggerAllSync: () => ipcRenderer.invoke('sync:trigger-all'),
    getSyncStatus: () => ipcRenderer.invoke('sync:get-status'),
    onSyncUpdate: (cb: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('sync:update', listener)
      return () => ipcRenderer.removeListener('sync:update', listener)
    }
  },

  // --- Knowledge Base ---
  knowledge: {
    listFiles: () => ipcRenderer.invoke('knowledge:list-files'),
    readFile: (relativePath: string) => ipcRenderer.invoke('knowledge:read-file', relativePath),
    writeFile: (relativePath: string, content: string) =>
      ipcRenderer.invoke('knowledge:write-file', relativePath, content),
    createFile: (relativePath: string, title: string) =>
      ipcRenderer.invoke('knowledge:create-file', relativePath, title),
    deleteFile: (relativePath: string) => ipcRenderer.invoke('knowledge:delete-file', relativePath),
    search: (query: string) => ipcRenderer.invoke('knowledge:search', query),
    onFileChanged: (cb: (path: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string) => cb(path)
      ipcRenderer.on('knowledge:file-changed', listener)
      return () => ipcRenderer.removeListener('knowledge:file-changed', listener)
    }
  },

  // --- Vault (Sensitive Data) ---
  vault: {
    getCategories: () => ipcRenderer.invoke('vault:get-categories'),
    getEntries: (category: string) => ipcRenderer.invoke('vault:get-entries', category),
    addEntry: (category: string, entry: unknown) =>
      ipcRenderer.invoke('vault:add-entry', category, entry),
    updateEntry: (category: string, id: string, entry: unknown) =>
      ipcRenderer.invoke('vault:update-entry', category, id, entry),
    deleteEntry: (category: string, id: string) =>
      ipcRenderer.invoke('vault:delete-entry', category, id),
    setContentProtection: (enabled: boolean) =>
      ipcRenderer.send('vault:set-content-protection', enabled)
  },

  // --- Checklist ---
  checklist: {
    getItems: (listType: string, date: string) =>
      ipcRenderer.invoke('checklist:get-items', listType, date),
    addItem: (item: unknown) => ipcRenderer.invoke('checklist:add-item', item),
    updateItem: (id: number, updates: unknown) =>
      ipcRenderer.invoke('checklist:update-item', id, updates),
    deleteItem: (id: number) => ipcRenderer.invoke('checklist:delete-item', id),
    rollOver: (fromDate: string, toDate: string) =>
      ipcRenderer.invoke('checklist:roll-over', fromDate, toDate),
    getTemplate: (listType: string) => ipcRenderer.invoke('checklist:get-template', listType),
    saveTemplate: (listType: string, content: string) =>
      ipcRenderer.invoke('checklist:save-template', listType, content)
  },

  // --- Calendar Events ---
  calendar: {
    getEvents: (start: string, end: string) =>
      ipcRenderer.invoke('calendar:get-events', start, end)
  },

  // --- GitHub Items ---
  github: {
    getItems: (state?: string) => ipcRenderer.invoke('github:get-items', state)
  },

  // --- Gmail Actions ---
  gmail: {
    getActions: (done?: boolean) => ipcRenderer.invoke('gmail:get-actions', done),
    markDone: (id: number) => ipcRenderer.invoke('gmail:mark-done', id)
  },

  // --- Settings ---
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:get-all'),
    openDataDir: () => ipcRenderer.invoke('settings:open-data-dir'),
    wipeKnowledge: () => ipcRenderer.invoke('settings:wipe-knowledge'),
    wipeVault: () => ipcRenderer.invoke('settings:wipe-vault')
  },

  // --- Theme ---
  theme: {
    getNativeTheme: () => ipcRenderer.invoke('get-native-theme'),
    onThemeChange: (cb: (theme: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, theme: string) => cb(theme)
      ipcRenderer.on('native-theme-changed', listener)
      return () => ipcRenderer.removeListener('native-theme-changed', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
