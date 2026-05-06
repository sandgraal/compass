import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Command,
  FileText,
  LayoutDashboard,
  Plug,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../../lib/utils'

interface CommandItem {
  id: string
  label: string
  sub?: string
  icon: React.ReactNode
  action: () => void
  group: 'navigate' | 'action' | 'knowledge'
  keywords?: string
}

const GROUP_LABELS: Record<string, string> = {
  navigate: 'Go to',
  action: 'Actions',
  knowledge: 'Knowledge Base'
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): JSX.Element | null {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [knowledgeResults, setKnowledgeResults] = useState<CommandItem[]>([])

  const go = useCallback(
    (path: string) => {
      navigate(path)
      onClose()
    },
    [navigate, onClose]
  )

  const staticCommands: CommandItem[] = [
    {
      id: 'nav-dashboard',
      label: 'Dashboard',
      sub: 'Today at a glance',
      icon: <LayoutDashboard size={15} />,
      action: () => go('/dashboard'),
      group: 'navigate',
      keywords: 'home today overview'
    },
    {
      id: 'nav-daily',
      label: 'Daily',
      sub: "Today's checklist",
      icon: <CalendarDays size={15} />,
      action: () => go('/daily'),
      group: 'navigate',
      keywords: 'tasks checklist today'
    },
    {
      id: 'nav-weekly',
      label: 'Weekly',
      sub: 'Week overview',
      icon: <CalendarRange size={15} />,
      action: () => go('/weekly'),
      group: 'navigate',
      keywords: 'week review'
    },
    {
      id: 'nav-monthly',
      label: 'Monthly',
      sub: 'Month planning',
      icon: <CalendarClock size={15} />,
      action: () => go('/monthly'),
      group: 'navigate',
      keywords: 'month plan habits goals'
    },
    {
      id: 'nav-knowledge',
      label: 'Knowledge Base',
      sub: 'Browse & edit notes',
      icon: <BookOpen size={15} />,
      action: () => go('/knowledge'),
      group: 'navigate',
      keywords: 'notes docs files markdown'
    },
    {
      id: 'nav-vault',
      label: 'Vault',
      sub: 'Encrypted secrets',
      icon: <ShieldCheck size={15} />,
      action: () => go('/vault'),
      group: 'navigate',
      keywords: 'passwords credentials secrets secure'
    },
    {
      id: 'nav-integrations',
      label: 'Integrations',
      sub: 'Connected services',
      icon: <Plug size={15} />,
      action: () => go('/integrations'),
      group: 'navigate',
      keywords: 'google github sync connect oauth'
    },
    {
      id: 'nav-settings',
      label: 'Settings',
      sub: 'App preferences',
      icon: <Settings size={15} />,
      action: () => go('/settings'),
      group: 'navigate',
      keywords: 'theme preferences'
    },
    {
      id: 'action-sync',
      label: 'Sync now',
      sub: 'Refresh all integrations',
      icon: <RefreshCw size={15} />,
      action: async () => {
        if (window.api) await window.api.sync.triggerAllSync()
        onClose()
      },
      group: 'action',
      keywords: 'refresh update pull fetch'
    }
  ]

  // Search knowledge base when query is 3+ chars
  useEffect(() => {
    if (query.length < 3 || !window.api) {
      setKnowledgeResults([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const results = await window.api.knowledge.search(query)
        const items: CommandItem[] = (results || [])
          .slice(0, 5)
          .map((r: { path: string; title: string; snippet?: string }) => ({
            id: `kb-${r.path}`,
            label: r.title,
            sub: r.snippet?.slice(0, 60) || r.path,
            icon: <FileText size={15} />,
            action: () => {
              go(`/knowledge/${r.path}`)
            },
            group: 'knowledge' as const
          }))
        setKnowledgeResults(items)
      } catch {
        /* ignore */
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [query, go])

  const filtered = [...staticCommands, ...knowledgeResults].filter((cmd) => {
    if (!query) return cmd.group !== 'knowledge'
    const q = query.toLowerCase()
    return (
      cmd.label.toLowerCase().includes(q) ||
      cmd.sub?.toLowerCase().includes(q) ||
      cmd.keywords?.includes(q)
    )
  })

  // Group the filtered items
  const groups = (['navigate', 'action', 'knowledge'] as const)
    .map((group) => ({
      group,
      items: filtered.filter((c) => c.group === group)
    }))
    .filter((g) => g.items.length > 0)

  // Flatten with group headers for keyboard index calculation
  const flatItems = groups.flatMap((g) => g.items)
  const safeSelected = Math.min(selected, Math.max(0, flatItems.length - 1))

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  // Keep selected item in view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${safeSelected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeSelected])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flatItems[safeSelected]?.action()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!open) return null

  let flatIdx = 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[18vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-full max-w-lg mx-4 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-scale-in">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={handleKey}
            placeholder="Search or jump to..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="hidden sm:flex items-center gap-1 text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-2">
          {flatItems.length === 0 ? (
            <div className="flex flex-col items-center py-10 gap-2 text-muted-foreground">
              <Command size={20} className="opacity-30" />
              <p className="text-sm">No results for "{query}"</p>
            </div>
          ) : (
            groups.map(({ group, items }) => (
              <div key={group}>
                <p className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {GROUP_LABELS[group]}
                </p>
                {items.map((cmd) => {
                  const idx = flatIdx++
                  return (
                    <button
                      key={cmd.id}
                      data-idx={idx}
                      onClick={cmd.action}
                      onMouseEnter={() => setSelected(idx)}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                        safeSelected === idx
                          ? 'bg-primary/10 text-foreground'
                          : 'text-foreground/80 hover:bg-secondary/60'
                      )}
                    >
                      <span
                        className={cn(
                          'shrink-0',
                          safeSelected === idx ? 'text-primary' : 'text-muted-foreground'
                        )}
                      >
                        {cmd.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{cmd.label}</p>
                        {cmd.sub && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{cmd.sub}</p>
                        )}
                      </div>
                      {safeSelected === idx && (
                        <ArrowRight size={13} className="text-primary shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-[11px] text-muted-foreground/50">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
