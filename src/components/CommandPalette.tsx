import {
  ArrowRight,
  BookOpen,
  Calendar,
  CalendarDays,
  CalendarRange,
  CheckSquare,
  Clock,
  CreditCard,
  DollarSign,
  Download,
  FileText,
  FolderOpen,
  Home,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  Network,
  PiggyBank,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Store,
  TrendingUp,
  Users,
  Wallet
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'
import { FINANCE_TAB_EVENT, FINANCE_TAB_STORAGE_KEY, type Tab } from '../pages/Finance'

interface Command {
  id: string
  label: string
  description?: string
  icon: React.ReactNode
  action: () => void
  keywords?: string[]
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function CommandPalette({ open, onClose }: Props): JSX.Element | null {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [searchHits, setSearchHits] = useState<GlobalSearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lastSearchTokenRef = useRef(0)

  const nav = (path: string) => {
    navigate(path)
    onClose()
  }

  // Jump straight to a specific Finance tab. Two cases:
  //   - Already on /finance: dispatch a CustomEvent that Finance.tsx
  //     listens for (the component is mounted and setTab handles it).
  //   - Elsewhere: stash the target tab in sessionStorage and navigate;
  //     Finance.tsx's useState initializer reads + consumes it on mount.
  // Mirrors the new-task pattern in this file.
  //
  // `target` is typed as `Tab` (imported from ../pages/Finance) so a typo
  // here fails the TypeScript build at the call site rather than landing
  // in storage and getting silently dropped by the runtime allowlist.
  const switchFinanceTab = (target: Tab) => {
    onClose()
    if (window.location.hash === '#/finance') {
      window.dispatchEvent(new CustomEvent(FINANCE_TAB_EVENT, { detail: target }))
    } else {
      sessionStorage.setItem(FINANCE_TAB_STORAGE_KEY, target)
      navigate('/finance')
    }
  }

  const COMMANDS: Command[] = [
    {
      id: 'new-task',
      label: 'New task for today',
      description: "Add a task to today's daily checklist",
      icon: <Plus size={15} />,
      action: async () => {
        onClose()
        if (window.location.hash === '#/daily') {
          // Already on Daily — dispatch event which resets date and focuses input
          window.dispatchEvent(new CustomEvent('compass:new-task'))
        } else {
          // Store pending action; Daily picks it up on mount (no race-prone timeout)
          sessionStorage.setItem('compass:pending-action', 'new-task')
          navigate('/daily')
        }
      },
      keywords: ['add', 'task', 'todo', 'checklist', 'new', 'create']
    },
    {
      id: 'overview',
      label: 'Overview',
      description: 'Everything in one place',
      icon: <LayoutGrid size={15} />,
      action: () => nav('/overview'),
      keywords: ['home', 'everything', 'summary', 'search', 'start']
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      description: 'Today at a glance',
      icon: <LayoutDashboard size={15} />,
      action: () => nav('/dashboard'),
      keywords: ['home', 'today']
    },
    {
      id: 'storehouse',
      label: 'Your Storehouse',
      description: 'See all your info in one place',
      icon: <Layers size={15} />,
      action: () => nav('/storehouse'),
      keywords: ['storehouse', 'overview', 'everything', 'all my info', 'summary']
    },
    {
      id: 'timeline',
      label: 'Timeline',
      description: 'Import data exports onto your timeline',
      icon: <Clock size={15} />,
      action: () => nav('/timeline'),
      keywords: ['timeline', 'import', 'records', 'history', 'drop', 'netflix', 'spotify']
    },
    {
      id: 'daily',
      label: 'Daily',
      description: 'Daily checklist',
      icon: <CalendarDays size={15} />,
      action: () => nav('/daily'),
      keywords: ['checklist', 'tasks', 'todo']
    },
    {
      id: 'weekly',
      label: 'Weekly',
      description: 'Weekly review & goals',
      icon: <CalendarRange size={15} />,
      action: () => nav('/weekly'),
      keywords: ['week', 'review']
    },
    {
      id: 'monthly',
      label: 'Monthly',
      description: 'Monthly planning & habits',
      icon: <Calendar size={15} />,
      action: () => nav('/monthly'),
      keywords: ['month', 'habits']
    },
    {
      id: 'knowledge',
      label: 'Knowledge Base',
      description: 'Browse & edit your notes',
      icon: <BookOpen size={15} />,
      action: () => nav('/knowledge'),
      keywords: ['notes', 'files', 'docs', 'kb']
    },
    {
      id: 'knowledge-search',
      label: 'Search knowledge base',
      description: 'Full-text search across all notes',
      icon: <Search size={15} />,
      action: () => {
        onClose()
        if (window.location.hash === '#/knowledge') {
          // Already on Knowledge Base — dispatch event directly
          window.dispatchEvent(new CustomEvent('compass:focus-search'))
        } else {
          // Store pending action; KnowledgeBase picks it up on mount
          sessionStorage.setItem('compass:pending-action', 'focus-search')
          navigate('/knowledge')
        }
      },
      keywords: ['find', 'search', 'notes', 'knowledge', 'lookup']
    },
    {
      id: 'ask-compass',
      label: 'Ask Compass',
      description: 'In-app RAG assistant grounded in your knowledge base',
      icon: <Sparkles size={15} />,
      action: () => {
        // If the user has typed a query, pre-fill the chat input with it.
        const q = query.trim()
        if (q.length > 0) sessionStorage.setItem('compass:ask:prefill', q)
        nav('/ask')
      },
      keywords: ['ask', 'assistant', 'chat', 'ai', 'llm', 'claude', 'gpt', 'rag']
    },
    {
      id: 'claude-inbox',
      label: 'Claude Inbox',
      description: 'Review & approve changes Claude proposed',
      icon: <Inbox size={15} />,
      action: () => nav('/claude-inbox'),
      keywords: ['claude', 'inbox', 'proposals', 'approve', 'review', 'mcp', 'pending']
    },
    {
      id: 'vault',
      label: 'Vault',
      description: 'Secure sensitive data',
      icon: <ShieldCheck size={15} />,
      action: () => nav('/vault'),
      keywords: ['secure', 'passwords', 'credentials', 'financial']
    },
    {
      id: 'contacts',
      label: 'Contacts',
      description: 'People, addresses & phone numbers',
      icon: <Users size={15} />,
      action: () => nav('/contacts'),
      keywords: ['people', 'address book', 'phone', 'vcard', 'friends', 'family']
    },
    {
      id: 'people',
      label: 'People',
      description: 'Everyone across your imported data',
      icon: <Network size={15} />,
      action: () => nav('/people'),
      keywords: ['connections', 'friends', 'linkedin', 'facebook', 'who', 'relationships']
    },
    {
      id: 'places',
      label: 'Merchants & Places',
      description: 'Businesses you buy from & places you go',
      icon: <Store size={15} />,
      action: () => nav('/places'),
      keywords: ['merchants', 'stores', 'shops', 'places', 'spending', 'amazon', 'paypal']
    },
    {
      id: 'subscriptions',
      label: 'Subscriptions',
      description: 'Track recurring costs & renewals',
      icon: <CreditCard size={15} />,
      action: () => nav('/subscriptions'),
      keywords: ['subscriptions', 'recurring', 'renewals', 'bills', 'memberships', 'cancel']
    },
    {
      id: 'assets',
      label: 'Household & Assets',
      description: 'Property, vehicles, insurance, warranties',
      icon: <Home size={15} />,
      action: () => nav('/assets'),
      keywords: [
        'assets',
        'house',
        'property',
        'vehicle',
        'car',
        'insurance',
        'warranty',
        'pet',
        'value'
      ]
    },
    {
      id: 'export',
      label: 'Export & Portability',
      description: 'Export your data in standard formats',
      icon: <Download size={15} />,
      action: () => nav('/export'),
      keywords: ['export', 'vcard', 'ics', 'csv', 'portable', 'own your data', 'backup']
    },
    {
      id: 'finance',
      label: 'Finance',
      description: 'Budget & transactions',
      icon: <TrendingUp size={15} />,
      action: () => nav('/finance'),
      keywords: ['budget', 'money', 'debt', 'spending']
    },
    {
      id: 'retirement',
      label: 'Retirement',
      description: 'Monte-Carlo retirement plan & assumptions',
      icon: <PiggyBank size={15} />,
      action: () => nav('/retirement'),
      keywords: [
        'retirement',
        'fire',
        'monte carlo',
        'drawdown',
        'projection',
        'ss',
        'social security'
      ]
    },
    {
      id: 'finance-networth',
      label: 'Net Worth',
      description: 'Assets, liabilities, and 12-month trajectory',
      icon: <Wallet size={15} />,
      action: () => switchFinanceTab('networth'),
      keywords: ['net worth', 'assets', 'liabilities', 'wealth', 'finance', 'trajectory']
    },
    {
      id: 'finance-forecast',
      label: 'Cash-flow forecast',
      description: '90-day projection with low-cash warnings',
      icon: <LineChart size={15} />,
      action: () => switchFinanceTab('forecast'),
      keywords: ['forecast', 'projection', 'cash flow', 'low cash', 'subscriptions', 'finance']
    },
    {
      id: 'integrations',
      label: 'Integrations',
      description: 'Connect external services',
      icon: <Plug size={15} />,
      action: () => nav('/integrations'),
      keywords: ['google', 'github', 'gmail', 'sync', 'connect']
    },
    {
      id: 'settings',
      label: 'Settings',
      description: 'App preferences',
      icon: <Settings size={15} />,
      action: () => nav('/settings'),
      keywords: ['preferences', 'theme', 'config']
    },
    {
      id: 'sync-all',
      label: 'Sync all services',
      description: 'Pull latest data from all connected integrations',
      icon: <RefreshCw size={15} />,
      action: () => {
        onClose()
        window.api?.sync.triggerAllSync()
      },
      keywords: ['sync', 'refresh', 'pull', 'update']
    },
    {
      id: 'open-data-dir',
      label: 'Open data folder',
      description: 'Show local data files in Finder',
      icon: <FolderOpen size={15} />,
      action: () => {
        onClose()
        window.api?.settings.openDataDir()
      },
      keywords: ['finder', 'folder', 'files', 'data', 'explorer']
    }
  ]

  const filteredCommands =
    query.trim() === ''
      ? COMMANDS
      : COMMANDS.filter((cmd) => {
          const q = query.toLowerCase()
          return (
            cmd.label.toLowerCase().includes(q) ||
            cmd.description?.toLowerCase().includes(q) ||
            cmd.keywords?.some((k) => k.includes(q))
          )
        })

  // Convert each global search hit into a Command so navigation, keyboard
  // selection, and the renderer's per-row code all stay identical to the
  // existing palette flow.
  const searchCommands: Command[] = searchHits.map((hit) => {
    if (hit.kind === 'knowledge') {
      return {
        id: `kb:${hit.path}`,
        label: hit.title,
        description: `Note · ${hit.snippet}`,
        icon: <FileText size={15} />,
        action: () => {
          onClose()
          sessionStorage.setItem('compass:open-knowledge', hit.path)
          if (window.location.hash === '#/knowledge') {
            window.dispatchEvent(new CustomEvent('compass:open-knowledge', { detail: hit.path }))
          } else {
            navigate('/knowledge')
          }
        }
      }
    }
    if (hit.kind === 'vault') {
      return {
        id: `vault:${hit.category}:${hit.id}`,
        label: hit.title,
        description: `Vault · ${hit.category}`,
        icon: <ShieldCheck size={15} />,
        action: () => {
          onClose()
          sessionStorage.setItem('compass:open-vault-category', hit.category)
          navigate('/vault')
        }
      }
    }
    if (hit.kind === 'task') {
      return {
        id: `task:${hit.id}`,
        label: hit.title,
        description: `${hit.done ? '✓ ' : ''}Task · ${hit.listType} · ${hit.listDate}`,
        icon: <CheckSquare size={15} />,
        action: () => {
          onClose()
          sessionStorage.setItem('compass:pending-action', 'focus-task')
          sessionStorage.setItem('compass:focus-task-date', hit.listDate)
          navigate(
            hit.listType === 'weekly'
              ? '/weekly'
              : hit.listType === 'monthly'
                ? '/monthly'
                : '/daily'
          )
        }
      }
    }
    return {
      id: `txn:${hit.id}`,
      label: hit.description,
      description: `Transaction · ${hit.date} · ${hit.amount.toFixed(2)}`,
      icon: <DollarSign size={15} />,
      action: () => {
        onClose()
        sessionStorage.setItem(FINANCE_TAB_STORAGE_KEY, 'transactions')
        navigate('/finance')
      }
    }
  })

  const filtered: Command[] = [...filteredCommands, ...searchCommands]

  // Focus input when opened. If a `compass://search?q=…` command put a
  // query into sessionStorage, pre-fill the input with it instead of
  // resetting.
  useEffect(() => {
    if (open) {
      const initial = sessionStorage.getItem('compass:palette-initial-query')
      if (initial !== null) {
        sessionStorage.removeItem('compass:palette-initial-query')
        setQuery(initial)
      } else {
        setQuery('')
      }
      setSearchHits([])
      setSelectedIdx(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  // Debounced global search (knowledge bodies, vault titles, tasks,
  // transactions). The lastSearchTokenRef guard makes sure an older,
  // slower response can't overwrite a newer one when the user types
  // quickly.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setSearchHits([])
      return
    }
    if (typeof window === 'undefined' || !window.api?.search) {
      return
    }
    const token = ++lastSearchTokenRef.current
    const handle = window.setTimeout(() => {
      window.api.search
        .global(trimmed)
        .then((res) => {
          if (token !== lastSearchTokenRef.current) return
          setSearchHits(res.hits ?? [])
        })
        .catch(() => {
          if (token !== lastSearchTokenRef.current) return
          setSearchHits([])
        })
    }, 120)
    return () => window.clearTimeout(handle)
  }, [open, query])

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        filtered[selectedIdx]?.action()
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: `filtered` is re-derived per render; handler must close over the current value
    [open, filtered, selectedIdx, onClose]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[selectedIdx] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close command palette"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Palette */}
      <div className="relative w-full max-w-lg mx-4 bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={15} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIdx(0)
            }}
            placeholder="Search notes, vault, tasks, transactions… or go to page"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded border border-border">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No results</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                type="button"
                key={cmd.id}
                onClick={cmd.action}
                onMouseEnter={() => setSelectedIdx(i)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                  i === selectedIdx
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-secondary/60'
                )}
              >
                <span
                  className={cn(
                    'shrink-0',
                    i === selectedIdx ? 'text-primary' : 'text-muted-foreground'
                  )}
                >
                  {cmd.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{cmd.label}</span>
                  {cmd.description && (
                    <span className="text-xs text-muted-foreground ml-2">{cmd.description}</span>
                  )}
                </div>
                {i === selectedIdx && <ArrowRight size={12} className="text-primary shrink-0" />}
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-xs text-muted-foreground">
          <span>
            <kbd className="bg-secondary px-1 rounded border border-border">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="bg-secondary px-1 rounded border border-border">↵</kbd> select
          </span>
          <span>
            <kbd className="bg-secondary px-1 rounded border border-border">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
