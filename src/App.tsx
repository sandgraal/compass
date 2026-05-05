import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import Dashboard from './pages/Dashboard'
import Daily from './pages/Daily'
import Weekly from './pages/Weekly'
import Monthly from './pages/Monthly'
import KnowledgeBase from './pages/KnowledgeBase'
import Vault from './pages/Vault'
import Integrations from './pages/Integrations'
import Finance from './pages/Finance'
import Settings from './pages/Settings'
import CommandPalette from './components/CommandPalette'
import { useAppStore } from './store/appStore'

export default function App(): JSX.Element {
  const { setTheme } = useAppStore()
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    // Sync with OS native theme
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.theme.getNativeTheme().then((t) => setTheme(t))
      const unsub = window.api.theme.onThemeChange((t) => setTheme(t as 'dark' | 'light'))
      return unsub
    } else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      setTheme(mq.matches ? 'dark' : 'light')
      const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [setTheme])

  // ⌘K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <HashRouter>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="daily" element={<Daily />} />
          <Route path="weekly" element={<Weekly />} />
          <Route path="monthly" element={<Monthly />} />
          <Route path="knowledge/*" element={<KnowledgeBase />} />
          <Route path="vault" element={<Vault />} />
          <Route path="finance" element={<Finance />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
