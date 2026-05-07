import { create } from 'zustand'

interface AppStore {
  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
  contextDrawerOpen: boolean
  setContextDrawerOpen: (open: boolean) => void
  syncing: Record<string, boolean>
  setSyncing: (service: string, value: boolean) => void
}

export const useAppStore = create<AppStore>((set) => ({
  theme: 'dark',
  setTheme: (theme) => {
    set({ theme })
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    if (theme === 'light') root.classList.add('light')
  },
  contextDrawerOpen: true,
  setContextDrawerOpen: (open) => set({ contextDrawerOpen: open }),
  syncing: {},
  setSyncing: (service, value) => set((s) => ({ syncing: { ...s.syncing, [service]: value } }))
}))
