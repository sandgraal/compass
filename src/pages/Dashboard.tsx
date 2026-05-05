import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, GitBranch, Inbox, ArrowRight, Plus, RefreshCw, Clock } from 'lucide-react'
import { format } from 'date-fns'
import { cn, formatTime, formatRelative, todayISO } from '../lib/utils'

interface DashStat {
  label: string
  value: string | number
  sub?: string
  color?: string
}

export default function Dashboard(): JSX.Element {
  const [greeting, setGreeting] = useState('')
  const [stats, setStats] = useState<DashStat[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<ChecklistItem[]>([])
  const [githubItems, setGithubItems] = useState<GitHubItem[]>([])
  const [inboxCount, setInboxCount] = useState(0)
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus[]>([])
  const [isSyncing, setIsSyncing] = useState(false)

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
      window.api.sync.getSyncStatus()
    ]).then(([checkItems, calEvents, ghItems, gmailItems, integrations]) => {
      setTasks(checkItems.slice(0, 5))
      setEvents(calEvents)
      setGithubItems(ghItems.slice(0, 4))
      setInboxCount(gmailItems.length)
      setIntegrationStatus(integrations)

      const done = checkItems.filter((i) => i.checked).length
      setStats([
        { label: 'Tasks Today', value: checkItems.length, sub: `${done} completed`, color: 'text-primary' },
        { label: 'GitHub Issues', value: ghItems.filter(g => g.type === 'issue').length, sub: 'assigned to you', color: 'text-amber-400' },
        { label: 'Inbox Actions', value: gmailItems.length, sub: 'need attention', color: 'text-emerald-400' },
        { label: 'Upcoming Events', value: calEvents.length, sub: 'next 7 days', color: 'text-sky-400' }
      ])
    })
  }

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
    // Reload all dashboard data now that the sync has completed
    loadData()
  }

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {greeting} 👋
          </h1>
          <p className="text-muted-foreground mt-1">
            {format(new Date(), "EEEE, MMMM d, yyyy")}
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={isSyncing}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(isSyncing && 'animate-spin')} />
          Sync now
        </button>
      </div>

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

      {/* Two-column grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Today's tasks */}
        <div className="bg-card border border-border rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Today's Tasks</h2>
            <Link to="/daily" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {tasks.length === 0 ? (
              <EmptyState icon={<Plus size={16} />} message="No tasks yet" action={{ to: '/daily', label: 'Add tasks' }} />
            ) : (
              tasks.map((task) => (
                <div key={task.id} className="flex items-center gap-3 px-5 py-3">
                  <div className={cn(
                    'w-4 h-4 rounded border shrink-0 flex items-center justify-center',
                    task.checked ? 'bg-primary border-primary' : 'border-border'
                  )}>
                    {task.checked && <span className="text-white text-xs">✓</span>}
                  </div>
                  <span className={cn('text-sm flex-1 truncate', task.checked && 'line-through text-muted-foreground')}>
                    {task.title}
                  </span>
                  <CategoryBadge category={task.category || 'personal'} />
                </div>
              ))
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
                      {!ev.allDay && ev.startAt ? ` · ${formatTime(ev.startAt)}` : ev.allDay ? ' · All day' : ''}
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
            <Link to="/integrations" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {githubItems.length === 0 ? (
              <EmptyState icon={<GitBranch size={16} />} message="Connect GitHub to see issues" action={{ to: '/integrations', label: 'Connect' }} />
            ) : (
              githubItems.map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-5 py-3">
                  <span className={cn(
                    'text-xs px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5',
                    item.type === 'pr' ? 'bg-purple-500/20 text-purple-400' : 'bg-amber-500/20 text-amber-400'
                  )}>
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

        {/* Integrations status */}
        <div className="bg-card border border-border rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock size={15} /> Sync Status
            </h2>
            <Link to="/integrations" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              Manage <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {integrationStatus.length === 0 ? (
              <EmptyState icon={<Clock size={16} />} message="No integrations connected" action={{ to: '/integrations', label: 'Connect' }} />
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
              <Link to="/integrations" className="flex items-center gap-2 px-5 py-3 text-xs text-primary hover:bg-secondary/50 transition-colors">
                <Plus size={12} /> Add integration
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ icon, message, action }: { icon: React.ReactNode; message: string; action?: { to: string; label: string } }): JSX.Element {
  return (
    <div className="flex flex-col items-center py-8 px-4 gap-2">
      <div className="text-muted-foreground/40">{icon}</div>
      <p className="text-sm text-muted-foreground">{message}</p>
      {action && (
        <Link to={action.to} className="text-xs text-primary hover:underline">{action.label}</Link>
      )}
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
    <span className={cn('text-xs px-1.5 py-0.5 rounded capitalize', colors[category] || 'bg-muted text-muted-foreground')}>
      {category}
    </span>
  )
}

function StatusDot({ status }: { status: string }): JSX.Element {
  return (
    <div className={cn(
      'w-2 h-2 rounded-full',
      status === 'connected' ? 'bg-emerald-500' :
      status === 'error' ? 'bg-red-500' : 'bg-muted-foreground/40'
    )} />
  )
}
