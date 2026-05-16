import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import CommandPalette from './components/CommandPalette'
import { AppLayout } from './components/layout/AppLayout'
import Ask from './pages/Ask'
import Daily from './pages/Daily'
import Dashboard from './pages/Dashboard'
import Finance from './pages/Finance'
import Integrations from './pages/Integrations'
import KnowledgeBase from './pages/KnowledgeBase'
import Monthly from './pages/Monthly'
import Settings from './pages/Settings'
import Vault from './pages/Vault'
import Weekly from './pages/Weekly'
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
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setTheme(mq.matches ? 'dark' : 'light')
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [setTheme])

  // ⌘K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <HashRouter>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <UrlSchemeBridge
        onOpenPalette={(initial) => {
          if (initial) sessionStorage.setItem('compass:palette-initial-query', initial)
          setPaletteOpen(true)
        }}
      />
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
          <Route path="ask" element={<Ask />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

// ─── compass:// URL-scheme bridge ─────────────────────────────────────────────
//
// Mounts inside the HashRouter so it can `useNavigate` when the main
// process fires `compass-url:open` / `compass-url:search`. Captures are
// handled in main and only surface as a passive toast here.
function UrlSchemeBridge({
  onOpenPalette
}: {
  onOpenPalette: (initialQuery: string) => void
}): null {
  const navigate = useNavigate()
  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api?.urlScheme
    if (!isElectron) return
    const unsubOpen = window.api.urlScheme.onOpen(({ page }) => {
      if (typeof page === 'string' && page.length > 0) navigate(`/${page}`)
    })
    const unsubSearch = window.api.urlScheme.onSearch(({ query }) => {
      onOpenPalette(query)
    })
    const unsubCaptured = window.api.urlScheme.onCaptured(() => {
      // Optional surface — the capture has already landed in the DB. The
      // toast system lives inside `<AppLayout>`, so for now we let the
      // sync of `/daily` reflect the new row when the user navigates there.
    })
    return () => {
      unsubOpen()
      unsubSearch()
      unsubCaptured()
    }
  }, [navigate, onOpenPalette])
  return null
}
