import {
  Blocks,
  BookOpen,
  Bookmark,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  Circle,
  Clock,
  CreditCard,
  Download,
  Home,
  IdCard,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Network,
  Plug2,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
  TrendingUp,
  Users
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { cn } from '../../lib/utils'

interface NavItem {
  label: string
  to: string
  icon: React.ReactNode
  badge?: number
}

interface SyncIndicator {
  service: string
  status: string
}

export function Sidebar(): JSX.Element {
  const [integrations, setIntegrations] = useState<SyncIndicator[]>([])
  const [inboxCount, setInboxCount] = useState(0)

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return

    // Load integration status
    window.api.sync.getSyncStatus().then((rows) => {
      setIntegrations(rows.map((r) => ({ service: r.service, status: r.status })))
    })

    // Load inbox count
    window.api.gmail
      .getActions(false)
      .then((actions) => {
        setInboxCount(actions.length)
      })
      .catch(() => {})

    const unsub = window.api.sync.onSyncUpdate((data) => {
      const d = data as { service: string; status: string }
      setIntegrations((prev) =>
        prev.map((i) =>
          i.service === d.service
            ? { ...i, status: d.status === 'success' ? 'connected' : 'error' }
            : i
        )
      )
      // Re-fetch inbox count after any sync
      if (d.service === 'google') {
        window.api?.gmail
          .getActions(false)
          .then((a) => setInboxCount(a.length))
          .catch(() => {})
      }
    })
    return unsub
  }, [])

  // Grouped into domains so the sidebar reads as ~7 scannable sections instead of
  // a flat wall of ~24 links. Routes are unchanged — this is organization, not a
  // re-route — so deep links, the command palette, and `compass://` all still work.
  const SECTIONS: { title: string; items: NavItem[] }[] = [
    {
      title: 'Home',
      items: [
        { label: 'Overview', to: '/overview', icon: <LayoutGrid size={18} /> },
        { label: 'Dashboard', to: '/dashboard', icon: <LayoutDashboard size={18} /> },
        { label: 'Timeline', to: '/timeline', icon: <Clock size={18} /> }
      ]
    },
    {
      title: 'People & Places',
      items: [
        { label: 'People', to: '/people', icon: <Network size={18} /> },
        { label: 'Contacts', to: '/contacts', icon: <Users size={18} /> },
        { label: 'Merchants & Places', to: '/places', icon: <Store size={18} /> }
      ]
    },
    {
      title: 'Money',
      items: [
        { label: 'Finance', to: '/finance', icon: <TrendingUp size={18} /> },
        { label: 'Subscriptions', to: '/subscriptions', icon: <CreditCard size={18} /> },
        { label: 'Household & Assets', to: '/assets', icon: <Home size={18} /> }
      ]
    },
    {
      title: 'Planner',
      items: [
        { label: 'Daily', to: '/daily', icon: <CalendarDays size={18} /> },
        { label: 'Weekly', to: '/weekly', icon: <CalendarRange size={18} /> },
        { label: 'Monthly', to: '/monthly', icon: <CalendarCheck size={18} /> }
      ]
    },
    {
      title: 'Knowledge',
      items: [
        { label: 'Knowledge Base', to: '/knowledge', icon: <BookOpen size={18} /> },
        { label: 'Ask Compass', to: '/ask', icon: <Sparkles size={18} /> },
        { label: 'Claude Inbox', to: '/claude-inbox', icon: <Inbox size={18} /> },
        { label: 'Vault', to: '/vault', icon: <ShieldCheck size={18} /> }
      ]
    },
    {
      title: 'Your Data',
      items: [
        { label: 'Storehouse', to: '/storehouse', icon: <Layers size={18} /> },
        { label: 'Ad Profile', to: '/ad-profile', icon: <Target size={18} /> },
        { label: 'Profile', to: '/profile', icon: <IdCard size={18} /> },
        { label: 'Apps & Websites', to: '/apps', icon: <Blocks size={18} /> },
        { label: 'Saved', to: '/google-saved', icon: <Bookmark size={18} /> },
        { label: 'Get Your Data', to: '/data-rights', icon: <ScrollText size={18} /> },
        { label: 'Export', to: '/export', icon: <Download size={18} /> }
      ]
    },
    {
      title: 'System',
      items: [
        {
          label: 'Integrations',
          to: '/integrations',
          icon: <Plug2 size={18} />,
          badge: inboxCount > 0 ? inboxCount : undefined
        },
        { label: 'Settings', to: '/settings', icon: <Settings size={18} /> }
      ]
    }
  ]

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

      {/* Nav links — grouped into domain sections */}
      <nav className="flex-1 px-3 py-2 overflow-y-auto">
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-3 last:mb-0">
            <p className="px-3 pt-1 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
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
                  <span className="flex-1">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="text-[10px] font-semibold bg-primary text-primary-foreground rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Integration status indicators */}
      {integrations.length > 0 && (
        <div className="px-4 py-3 border-t border-sidebar-border">
          <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wider">
            Integrations
          </p>
          <div className="space-y-1.5">
            {integrations.map((i) => (
              <div key={i.service} className="flex items-center gap-2">
                <Circle
                  size={6}
                  className={cn(
                    'fill-current',
                    i.status === 'connected'
                      ? 'text-emerald-500'
                      : i.status === 'error'
                        ? 'text-red-500'
                        : 'text-muted-foreground'
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
          type="button"
          onClick={() => {
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
            )
          }}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md bg-sidebar-accent/40 hover:bg-sidebar-accent/70 transition-colors group"
        >
          <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
            Search...
          </span>
          <kbd className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60 font-mono">
            <span>⌘</span>
            <span>K</span>
          </kbd>
        </button>
        <p className="text-xs text-muted-foreground/50">Compass v0.1.0 · Local only</p>
      </div>
    </aside>
  )
}
