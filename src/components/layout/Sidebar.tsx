import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, CalendarDays, CalendarRange, CalendarCheck,
  BookOpen, ShieldCheck, Plug2, Settings, Circle, TrendingUp
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useEffect, useState } from 'react'

interface NavItem {
  label: string
  to: string
  icon: React.ReactNode
}

const NAV: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: <LayoutDashboard size={18} /> },
  { label: 'Daily', to: '/daily', icon: <CalendarDays size={18} /> },
  { label: 'Weekly', to: '/weekly', icon: <CalendarRange size={18} /> },
  { label: 'Monthly', to: '/monthly', icon: <CalendarCheck size={18} /> },
  { label: 'Knowledge Base', to: '/knowledge', icon: <BookOpen size={18} /> },
  { label: 'Vault', to: '/vault', icon: <ShieldCheck size={18} /> },
  { label: 'Finance', to: '/finance', icon: <TrendingUp size={18} /> },
  { label: 'Integrations', to: '/integrations', icon: <Plug2 size={18} /> },
  { label: 'Settings', to: '/settings', icon: <Settings size={18} /> },
]

interface SyncIndicator {
  service: string
  status: string
}

export function Sidebar(): JSX.Element {
  const location = useLocation()
  const [integrations, setIntegrations] = useState<SyncIndicator[]>([])

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return

    window.api.sync.getSyncStatus().then((rows) => {
      setIntegrations(rows.map((r) => ({ service: r.service, status: r.status })))
    })

    const unsub = window.api.sync.onSyncUpdate((data) => {
      const d = data as { service: string; status: string }
      setIntegrations((prev) =>
        prev.map((i) => i.service === d.service ? { ...i, status: d.status === 'success' ? 'connected' : 'error' } : i)
      )
    })
    return unsub
  }, [])

  return (
    <aside className="w-60 flex flex-col bg-sidebar border-r border-sidebar-border shrink-0 pt-10">
      {/* Logo */}
      <div className="px-5 py-4 titlebar-no-drag">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
            <span className="text-primary text-sm font-bold">C</span>
          </div>
          <span className="font-semibold text-foreground tracking-tight">Compass</span>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/60'
              )
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Integration status indicators */}
      {integrations.length > 0 && (
        <div className="px-4 py-3 border-t border-sidebar-border">
          <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wider">Integrations</p>
          <div className="space-y-1.5">
            {integrations.map((i) => (
              <div key={i.service} className="flex items-center gap-2">
                <Circle
                  size={6}
                  className={cn(
                    'fill-current',
                    i.status === 'connected' ? 'text-emerald-500' :
                    i.status === 'error' ? 'text-red-500' : 'text-muted-foreground'
                  )}
                />
                <span className="text-xs text-muted-foreground capitalize">{i.service}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ⌘K hint + App version */}
      <div className="px-5 py-3 border-t border-sidebar-border space-y-2">
        <button
          onClick={() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })) }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-sidebar-accent/40 hover:bg-sidebar-accent/70 transition-colors group"
        >
          <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">Search...</span>
          <kbd className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60 font-mono">
            <span>⌘</span><span>K</span>
          </kbd>
        </button>
        <p className="text-xs text-muted-foreground/50">Compass v0.1.0 · Local only</p>
      </div>
    </aside>
  )
}
