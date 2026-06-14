import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import CommandPalette from './components/CommandPalette'
import { AppLayout } from './components/layout/AppLayout'
import { isThemePreference } from './lib/theme'
import Ask from './pages/Ask'
import ClaudeInbox from './pages/ClaudeInbox'
import Contacts from './pages/Contacts'
import Daily from './pages/Daily'
import Dashboard from './pages/Dashboard'
import Export from './pages/Export'
import Finance from './pages/Finance'
import Integrations from './pages/Integrations'
import KnowledgeBase from './pages/KnowledgeBase'
import Monthly from './pages/Monthly'
import Settings from './pages/Settings'
import Subscriptions from './pages/Subscriptions'
import Vault from './pages/Vault'
import Weekly from './pages/Weekly'
import { useAppStore } from './store/appStore'

export default function App(): JSX.Element {
  const { setThemePreference, setOsTheme, setAccent } = useAppStore()
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    // Theme: restore the saved preference (dark/light/system) + accent, then
    // track the OS theme — OS changes only take effect while the preference
    // is 'system' (the store resolves that).
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.settings.getAll().then((s) => {
        setThemePreference(isThemePreference(s.theme) ? s.theme : 'system')
        if (s.accentColor) setAccent(s.accentColor)
      })
      window.api.theme.getNativeTheme().then((t) => setOsTheme(t))
      const unsub = window.api.theme.onThemeChange((t) => setOsTheme(t as 'dark' | 'light'))
      return unsub
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setOsTheme(mq.matches ? 'dark' : 'light')
    const handler = (e: MediaQueryListEvent) => setOsTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [setThemePreference, setOsTheme, setAccent])

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
          <Route path="contacts" element={<Contacts />} />
          <Route path="finance" element={<Finance />} />
          <Route path="subscriptions" element={<Subscriptions />} />
          <Route path="export" element={<Export />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="settings" element={<Settings />} />
          <Route path="ask" element={<Ask />} />
          <Route path="claude-inbox" element={<ClaudeInbox />} />
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
