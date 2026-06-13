import { format } from 'date-fns'
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Clock,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
  Wallet
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { MorningBrief } from '../components/MorningBrief'
import { ProactiveInsights } from '../components/ProactiveInsights'
import { cn, formatRelative, formatTime, todayISO } from '../lib/utils'

interface DashStat {
  label: string
  value: string | number
  sub?: string
  color?: string
}

type UpcomingPayment = {
  id: number
  name: string
  institution: string
  paymentDueDate: string
  minPayment: number
  balance: number
  daysRemaining: number
}

export default function Dashboard(): JSX.Element {
  const [greeting, setGreeting] = useState('')
  const [stats, setStats] = useState<DashStat[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<ChecklistItem[]>([])
  const [githubItems, setGithubItems] = useState<GitHubItem[]>([])
  const [linearItems, setLinearItems] = useState<LinearIssue[]>([])
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus[]>([])
  const [upcomingPayments, setUpcomingPayments] = useState<UpcomingPayment[]>([])
  const [isSyncing, setIsSyncing] = useState(false)
  const [quickAdd, setQuickAdd] = useState(false)
  const [quickAddText, setQuickAddText] = useState('')
  const quickAddRef = useRef<HTMLInputElement>(null)
  const isSubmittingRef = useRef(false)

  const loadData = () => {
    if (typeof window === 'undefined' || !window.api) return

    const today = todayISO()
    const now = new Date()
    const endOfDay = new Date(now)
    endOfDay.setHours(23, 59, 59)
    const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    Promise.all([
      window.api.checklist.getItems('daily', today),
      window.api.calendar.getEvents(now.toISOString(), sevenDaysOut.toISOString()),
      window.api.github.getItems('open'),
      window.api.gmail.getActions(false),
      window.api.sync.getSyncStatus(),
      window.api.finance?.getUpcomingPayments
        ? window.api.finance.getUpcomingPayments(14).catch(() => [])
        : Promise.resolve([]),
      window.api.linear?.getItems
        ? window.api.linear.getItems().catch(() => [])
        : Promise.resolve([])
    ]).then(([checkItems, calEvents, ghItems, gmailItems, integrations, payments, linItems]) => {
      setTasks(checkItems.slice(0, 5))
      setEvents(calEvents)
      setGithubItems(ghItems.slice(0, 4))
      setLinearItems((linItems as LinearIssue[]).slice(0, 4))
      setIntegrationStatus(integrations)
      setUpcomingPayments(payments as UpcomingPayment[])

      const done = checkItems.filter((i) => i.checked).length
      setStats([
        {
          label: 'Tasks Today',
          value: checkItems.length,
          sub: `${done} completed`,
          color: 'text-primary'
        },
        {
          label: 'GitHub Issues',
          value: ghItems.filter((g) => g.type === 'issue').length,
          sub: 'assigned to you',
          color: 'text-amber-400'
        },
        {
          label: 'Inbox Actions',
          value: gmailItems.length,
          sub: 'need attention',
          color: 'text-emerald-400'
        },
        {
          label: 'Upcoming Events',
          value: calEvents.length,
          sub: 'next 7 days',
          color: 'text-sky-400'
        }
      ])
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only initialization
  useEffect(() => {
    const hour = new Date().getHours()
    setGreeting(hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening')

    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) {
      setStats([
        { label: 'Tasks Today', value: 8, sub: '3 completed', color: 'text-primary' },
        { label: 'GitHub Issues', value: 5, sub: 'assigned to you', color: 'text-amber-400' },
        { label: 'Unread Actions', value: 12, sub: 'in inbox', color: 'text-emerald-400' },
        { label: 'Events Today', value: 3, sub: 'on calendar', color: 'text-sky-400' }
      ])
      return
    }

    loadData()
  }, [])

  const handleSync = async () => {
    if (!window.api) return
    setIsSyncing(true)
    await window.api.sync.triggerAllSync()
    setIsSyncing(false)
    loadData()
  }

  const openQuickAdd = () => {
    setQuickAdd(true)
    setTimeout(() => quickAddRef.current?.focus(), 10)
  }

  const submitQuickAdd = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!quickAddText.trim() || !window.api || isSubmittingRef.current) return
    isSubmittingRef.current = true
    try {
      const today = todayISO()
      const allItems = await window.api.checklist.getItems('daily', today)
      await window.api.checklist.addItem({
        listType: 'daily',
        listDate: today,
        title: quickAddText.trim(),
        category: 'personal',
        source: 'manual',
        sortOrder: allItems.length
      })
      setQuickAddText('')
      setQuickAdd(false)
      loadData()
    } finally {
      isSubmittingRef.current = false
    }
  }

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{greeting} 👋</h1>
          <p className="text-muted-foreground mt-1">{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>
        <button
          type="button"
          onClick={handleSync}
          disabled={isSyncing}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(isSyncing && 'animate-spin')} />
          Sync now
        </button>
      </div>

      {/* Morning Brief — one glanceable digest of what matters today */}
      <MorningBrief />

      {/* Proactive insights — local-only nudges (Phase 7 Track E) */}
      <ProactiveInsights />

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-card border border-border rounded-xl p-4">
            <p className={cn('text-2xl font-semibold', stat.color)}>{stat.value}</p>
            <p className="text-sm font-medium text-foreground mt-1">{stat.label}</p>
            {stat.sub && <p className="text-xs text-muted-foreground mt-0.5">{stat.sub}</p>}
          </div>
        ))}
      </div>

      {/* Payments Due — surfaced from PDF statement metadata. Only shown when
          at least one debt account has a payment_due_date within ~14 days. */}
      {upcomingPayments.length > 0 ? (
        <div className="bg-card border border-border rounded-xl mb-6">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Wallet size={15} /> Payments Due
            </h2>
            <Link
              to="/finance"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              View accounts <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {upcomingPayments.map((p) => (
              <Link
                key={p.id}
                to="/finance"
                className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors"
              >
                <PaymentDueBadge daysRemaining={p.daysRemaining} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Due {format(new Date(`${p.paymentDueDate}T00:00:00`), 'EEE, MMM d')}
                    {p.minPayment > 0
                      ? ` · Min ${p.minPayment.toLocaleString('en-US', {
                          style: 'currency',
                          currency: 'USD'
                        })}`
                      : ''}
                  </p>
                </div>
                <span
                  className={cn(
                    'text-xs font-medium shrink-0',
                    p.daysRemaining < 0
                      ? 'text-rose-400'
                      : p.daysRemaining <= 3
                        ? 'text-amber-400'
                        : 'text-muted-foreground'
                  )}
                >
                  {p.daysRemaining < 0
                    ? `${Math.abs(p.daysRemaining)}d overdue`
                    : p.daysRemaining === 0
                      ? 'Due today'
                      : `in ${p.daysRemaining}d`}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* Two-column grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Today's tasks */}
        <div className="bg-card border border-border rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Today's Tasks</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openQuickAdd}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                title="Quick-add task (or use ⌘K → New task)"
              >
                <Plus size={12} /> Add
              </button>
              <Link
                to="/daily"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                View all <ArrowRight size={12} />
              </Link>
            </div>
          </div>
          <div className="divide-y divide-border">
            {tasks.length === 0 && !quickAdd ? (
              <EmptyState icon={<Plus size={16} />} message="No tasks yet — add one below" />
            ) : (
              tasks.map((task) => (
                <div key={task.id} className="flex items-center gap-3 px-5 py-3">
                  <div
                    className={cn(
                      'w-4 h-4 rounded border shrink-0 flex items-center justify-center',
                      task.checked ? 'bg-primary border-primary' : 'border-border'
                    )}
                  >
                    {task.checked && <span className="text-white text-xs">✓</span>}
                  </div>
                  <span
                    className={cn(
                      'text-sm flex-1 truncate',
                      task.checked && 'line-through text-muted-foreground'
                    )}
                  >
                    {task.title}
                  </span>
                  <CategoryBadge category={task.category || 'personal'} />
                </div>
              ))
            )}
            {/* Quick-add inline form */}
            {quickAdd ? (
              <form
                onSubmit={submitQuickAdd}
                className="flex items-center gap-2 px-5 py-3 border-t border-border"
              >
                <Plus size={13} className="text-muted-foreground shrink-0" />
                <input
                  ref={quickAddRef}
                  value={quickAddText}
                  onChange={(e) => setQuickAddText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuickAdd(false)
                      setQuickAddText('')
                    }
                  }}
                  placeholder="Task title… (Enter to save, Esc to cancel)"
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
                />
                <button type="submit" className="text-xs text-primary hover:underline">
                  Save
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={openQuickAdd}
                className="w-full flex items-center gap-2 px-5 py-3 text-xs text-muted-foreground/50 hover:text-primary hover:bg-secondary/40 transition-colors"
              >
                <Plus size={12} /> New task for today…
              </button>
            )}
          </div>
        </div>

        {/* Today's events */}
        <div className="bg-card border border-border rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Calendar size={15} /> Upcoming Events
            </h2>
          </div>
          <div className="divide-y divide-border">
            {events.length === 0 ? (
              <EmptyState icon={<Calendar size={16} />} message="No upcoming events" />
            ) : (
              events.map((ev) => (
                <div key={ev.id} className="flex items-start gap-3 px-5 py-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{ev.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {ev.startAt ? format(new Date(ev.startAt), 'EEE, MMM d') : ''}
                      {!ev.allDay && ev.startAt
                        ? ` · ${formatTime(ev.startAt)}`
                        : ev.allDay
                          ? ' · All day'
                          : ''}
                      {ev.location ? ` · ${ev.location}` : ''}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* GitHub items */}
        <div className="bg-card border border-border rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <GitBranch size={15} /> GitHub
            </h2>
            <Link
              to="/integrations"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {githubItems.length === 0 ? (
              <EmptyState
                icon={<GitBranch size={16} />}
                message="Connect GitHub to see issues"
                action={{ to: '/integrations', label: 'Connect' }}
              />
            ) : (
              githubItems.map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-5 py-3">
                  <span
                    className={cn(
                      'text-xs px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5',
                      item.type === 'pr'
                        ? 'bg-purple-500/20 text-purple-400'
                        : 'bg-amber-500/20 text-amber-400'
                    )}
                  >
                    {item.type === 'pr' ? 'PR' : '#'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{item.repo}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Linear issues — only shown once connected (has synced items) so it
            doesn't add a permanent empty card for users who don't use Linear. */}
        {linearItems.length > 0 && (
          <div className="bg-card border border-border rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Layers size={15} /> Linear
              </h2>
              <Link
                to="/integrations"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                View all <ArrowRight size={12} />
              </Link>
            </div>
            <div className="divide-y divide-border">
              {linearItems.map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-5 py-3">
                  <span className="text-xs px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5 bg-indigo-500/20 text-indigo-400">
                    {item.identifier}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{item.state}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Integrations status */}
        <div className="bg-card border border-border rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock size={15} /> Sync Status
            </h2>
            <Link
              to="/integrations"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              Manage <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {integrationStatus.length === 0 ? (
              <EmptyState
                icon={<Clock size={16} />}
                message="No integrations connected"
                action={{ to: '/integrations', label: 'Connect' }}
              />
            ) : (
              integrationStatus.map((i) => (
                <div key={i.service} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-2">
                    <StatusDot status={i.status} />
                    <span className="text-sm text-foreground capitalize">{i.service}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {i.lastSyncedAt ? formatRelative(i.lastSyncedAt) : 'Never synced'}
                  </span>
                </div>
              ))
            )}
            {integrationStatus.length < 2 && (
              <Link
                to="/integrations"
                className="flex items-center gap-2 px-5 py-3 text-xs text-primary hover:bg-secondary/50 transition-colors"
              >
                <Plus size={12} /> Add integration
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState({
  icon,
  message,
  action
}: {
  icon: React.ReactNode
  message: string
  action?: { to: string; label: string }
}): JSX.Element {
  return (
    <div className="flex flex-col items-center py-8 px-4 gap-2">
      <div className="text-muted-foreground/40">{icon}</div>
      <p className="text-sm text-muted-foreground">{message}</p>
      {action && (
        <Link to={action.to} className="text-xs text-primary hover:underline">
          {action.label}
        </Link>
      )}
    </div>
  )
}

function PaymentDueBadge({ daysRemaining }: { daysRemaining: number }): JSX.Element {
  const overdue = daysRemaining < 0
  const soon = daysRemaining >= 0 && daysRemaining <= 3
  return (
    <div
      className={cn(
        'w-7 h-7 rounded-full shrink-0 flex items-center justify-center',
        overdue
          ? 'bg-rose-500/15 text-rose-400'
          : soon
            ? 'bg-amber-500/15 text-amber-400'
            : 'bg-secondary text-muted-foreground'
      )}
    >
      <AlertCircle size={14} />
    </div>
  )
}

function CategoryBadge({ category }: { category: string }): JSX.Element {
  const colors: Record<string, string> = {
    morning: 'bg-amber-500/10 text-amber-400',
    work: 'bg-blue-500/10 text-blue-400',
    personal: 'bg-purple-500/10 text-purple-400',
    evening: 'bg-indigo-500/10 text-indigo-400'
  }
  return (
    <span
      className={cn(
        'text-xs px-1.5 py-0.5 rounded capitalize',
        colors[category] || 'bg-muted text-muted-foreground'
      )}
    >
      {category}
    </span>
  )
}

function StatusDot({ status }: { status: string }): JSX.Element {
  return (
    <div
      className={cn(
        'w-2 h-2 rounded-full',
        status === 'connected'
          ? 'bg-emerald-500'
          : status === 'error'
            ? 'bg-red-500'
            : 'bg-muted-foreground/40'
      )}
    />
  )
}
