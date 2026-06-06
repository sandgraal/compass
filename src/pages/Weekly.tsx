import {
  addWeeks,
  eachDayOfInterval,
  endOfWeek,
  format,
  isSameDay,
  startOfWeek,
  subWeeks
} from 'date-fns'
import {
  ArrowRight,
  Calendar,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  GitBranch
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../components/ui/Toast'
import { cn, isoDate } from '../lib/utils'

export default function Weekly(): JSX.Element {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [allItems, setAllItems] = useState<Record<string, ChecklistItem[]>>({})
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [githubItems, setGithubItems] = useState<GitHubItem[]>([])
  const [goals, setGoals] = useState(['', '', ''])
  const [reflection, setReflection] = useState({ wellDone: '', blockers: '', next: '' })
  const [prevCompletionPct, setPrevCompletionPct] = useState<number | null>(null)
  // Carry-over: count of unfinished manual tasks this week (from weekly-review:get).
  const [carryOverCount, setCarryOverCount] = useState(0)
  const [reloadNonce, setReloadNonce] = useState(0)
  const { toast } = useToast()

  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd })
  const isCurrentWeek = isSameDay(weekStart, startOfWeek(new Date(), { weekStartsOn: 1 }))
  const weekKey = isoDate(weekStart)

  // biome-ignore lint/correctness/useExhaustiveDependencies: days, weekEnd, weekKey are pure derivatives of weekStart
  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return

    const prevWeekStart = subWeeks(weekStart, 1)
    const prevWeekEnd = endOfWeek(prevWeekStart, { weekStartsOn: 1 })
    const prevDays = eachDayOfInterval({ start: prevWeekStart, end: prevWeekEnd })

    // Load checklist + calendar + github + persisted goals/reflection + prev week checklist
    Promise.all([
      ...days.map((d) => window.api.checklist.getItems('daily', isoDate(d))),
      window.api.calendar.getEvents(weekStart.toISOString(), weekEnd.toISOString()),
      window.api.github.getItems('open'),
      window.api.settings.getAll(),
      ...prevDays.map((d) => window.api.checklist.getItems('daily', isoDate(d)))
    ]).then((results) => {
      const itemResults = results.slice(0, 7) as ChecklistItem[][]
      const itemMap: Record<string, ChecklistItem[]> = {}
      days.forEach((d, i) => {
        itemMap[isoDate(d)] = itemResults[i]
      })
      setAllItems(itemMap)
      setEvents(results[7] as CalendarEvent[])
      setGithubItems(results[8] as GitHubItem[])

      // Weekly review close-out stats (carry-over candidates).
      window.api.weeklyReview
        ?.get(isoDate(weekStart))
        .then((r) => setCarryOverCount(r.carryOver.count))
        .catch(() => setCarryOverCount(0))

      const s = results[9] as Record<string, string>
      const savedGoals = s[`weekly_goals_${weekKey}`]
      const savedReflection = s[`weekly_reflection_${weekKey}`]
      try {
        if (savedGoals) setGoals(JSON.parse(savedGoals))
      } catch {
        /* ignore corrupt data */
      }
      try {
        if (savedReflection) setReflection(JSON.parse(savedReflection))
      } catch {
        /* ignore corrupt data */
      }

      // Compute prev week completion %
      const prevItems = (results.slice(10, 17) as ChecklistItem[][]).flat()
      if (prevItems.length > 0) {
        setPrevCompletionPct(
          Math.round((prevItems.filter((i) => i.checked).length / prevItems.length) * 100)
        )
      } else {
        setPrevCompletionPct(null)
      }
    })
  }, [weekStart, reloadNonce])

  const goalsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reflectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (goalsTimerRef.current) clearTimeout(goalsTimerRef.current)
      if (reflectionTimerRef.current) clearTimeout(reflectionTimerRef.current)
    }
  }, [])

  const saveGoals = useCallback(
    (newGoals: string[]) => {
      setGoals(newGoals)
      if (!window.api) return
      if (goalsTimerRef.current) clearTimeout(goalsTimerRef.current)
      goalsTimerRef.current = setTimeout(() => {
        window.api.settings.set(`weekly_goals_${weekKey}`, JSON.stringify(newGoals))
      }, 500)
    },
    [weekKey]
  )

  const saveReflection = useCallback(
    (newReflection: typeof reflection) => {
      setReflection(newReflection)
      if (!window.api) return
      if (reflectionTimerRef.current) clearTimeout(reflectionTimerRef.current)
      reflectionTimerRef.current = setTimeout(() => {
        window.api.settings.set(`weekly_reflection_${weekKey}`, JSON.stringify(newReflection))
      }, 500)
    },
    [weekKey]
  )

  async function handleCarryOver() {
    if (typeof window === 'undefined' || !window.api?.weeklyReview) return
    try {
      const res = await window.api.weeklyReview.carryOver(isoDate(weekStart))
      if (res.success) {
        const n = res.carried ?? 0
        toast(
          n > 0
            ? `Carried ${n} unfinished task${n === 1 ? '' : 's'} to today`
            : 'Nothing to carry over',
          n > 0 ? 'success' : 'info'
        )
        setReloadNonce((v) => v + 1)
      } else {
        toast(res.error ?? 'Carry-over failed', 'error')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Carry-over failed', 'error')
    }
  }

  const totalTasks = Object.values(allItems).flat().length
  const completedTasks = Object.values(allItems)
    .flat()
    .filter((i) => i.checked).length
  const completionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const now = new Date()
  const totalEvents = events.length
  const attendedEvents = events.filter((e) => e.startAt && new Date(e.startAt) < now).length
  const isPastWeek = weekEnd < now

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setWeekStart(subWeeks(weekStart, 1))}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {isCurrentWeek ? 'This Week' : `Week of ${format(weekStart, 'MMM d')}`}
            </h1>
            <p className="text-sm text-muted-foreground">
              {format(weekStart, 'MMM d')} – {format(weekEnd, 'MMM d, yyyy')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setWeekStart(addWeeks(weekStart, 1))}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
          >
            <ChevronRight size={16} />
          </button>
          {!isCurrentWeek && (
            <button
              type="button"
              onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
              className="text-xs text-primary hover:underline"
            >
              Current week
            </button>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CheckSquare size={14} className="text-primary" />
            {completedTasks}/{totalTasks} tasks
          </span>
          <div className="flex items-center gap-2">
            <div className="w-24 h-1.5 bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${completionPct}%` }}
              />
            </div>
            <span>{completionPct}%</span>
          </div>
          {prevCompletionPct !== null &&
            (() => {
              const delta = completionPct - prevCompletionPct
              if (delta === 0)
                return <span className="text-xs text-muted-foreground">= last week</span>
              const up = delta > 0
              return (
                <span
                  className={cn(
                    'text-xs flex items-center gap-0.5',
                    up ? 'text-emerald-400' : 'text-red-400'
                  )}
                >
                  {up ? '↑' : '↓'}
                  {Math.abs(delta)}% vs last week
                </span>
              )
            })()}
          {totalEvents > 0 && (
            <span className="flex items-center gap-1.5">
              <Calendar size={14} className="text-sky-400" />
              {isPastWeek
                ? `${attendedEvents} events attended`
                : `${attendedEvents} / ${totalEvents} events`}
            </span>
          )}
        </div>
      </div>

      {/* 7-day grid */}
      <div className="grid grid-cols-7 gap-3 mb-8">
        {days.map((day) => {
          const dayItems = allItems[isoDate(day)] || []
          const done = dayItems.filter((i) => i.checked).length
          const isToday = isSameDay(day, new Date())
          const dayKey = isoDate(day)
          const dayEvents = events.filter((e) => {
            if (!e.startAt) return false
            const d = new Date(e.startAt)
            return isoDate(d) === dayKey
          })
          const isEmpty = dayItems.length === 0 && dayEvents.length === 0
          return (
            <div
              key={dayKey}
              className={cn(
                'bg-card border rounded-xl p-3 min-h-[120px]',
                isToday ? 'border-primary/50' : 'border-border'
              )}
            >
              <div
                className={cn(
                  'text-xs font-medium mb-2',
                  isToday ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <div>{format(day, 'EEE')}</div>
                <div
                  className={cn(
                    'text-lg font-semibold mt-0.5',
                    isToday ? 'text-primary' : 'text-foreground'
                  )}
                >
                  {format(day, 'd')}
                </div>
              </div>

              {isEmpty ? (
                <p className="text-xs text-muted-foreground/40">Clear</p>
              ) : (
                <div className="space-y-2">
                  {/* Calendar events */}
                  {dayEvents.length > 0 && (
                    <div className="space-y-1">
                      {dayEvents.slice(0, 2).map((ev) => (
                        <div key={ev.id} className="flex items-center gap-1.5 min-w-0">
                          <Calendar size={9} className="text-sky-400 shrink-0" />
                          <span className="text-xs text-sky-300 truncate leading-tight">
                            {ev.allDay
                              ? ev.title
                              : `${format(new Date(ev.startAt!), 'h:mma').toLowerCase()} ${ev.title}`}
                          </span>
                        </div>
                      ))}
                      {dayEvents.length > 2 && (
                        <p className="text-xs text-muted-foreground/50 pl-3.5">
                          +{dayEvents.length - 2} events
                        </p>
                      )}
                    </div>
                  )}

                  {/* Tasks */}
                  {dayItems.length > 0 && (
                    <div>
                      <div className="space-y-1">
                        {dayItems.slice(0, 3).map((item) => (
                          <div key={item.id} className="flex items-center gap-1.5">
                            <div
                              className={cn(
                                'w-1.5 h-1.5 rounded-full shrink-0',
                                item.checked ? 'bg-primary' : 'bg-border'
                              )}
                            />
                            <span
                              className={cn(
                                'text-xs truncate',
                                item.checked && 'line-through text-muted-foreground'
                              )}
                            >
                              {item.title}
                            </span>
                          </div>
                        ))}
                        {dayItems.length > 3 && (
                          <p className="text-xs text-muted-foreground/60">
                            +{dayItems.length - 3} more
                          </p>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {done}/{dayItems.length} tasks
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Two-column: Goals + GitHub */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckSquare size={14} /> Weekly Goals
          </h3>
          <div className="space-y-2">
            {goals.map((goal, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: goals are positional slots (Goal 1..N), never reordered
              <div key={i} className="flex items-center gap-2">
                <div className="w-5 h-5 rounded border border-border shrink-0 flex items-center justify-center text-xs text-muted-foreground">
                  {i + 1}
                </div>
                <input
                  value={goal}
                  onChange={(e) => saveGoals(goals.map((g, j) => (j === i ? e.target.value : g)))}
                  placeholder={`Goal ${i + 1}…`}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <GitBranch size={14} /> Open Issues
          </h3>
          {githubItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open issues.</p>
          ) : (
            <div className="space-y-2">
              {githubItems.slice(0, 5).map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <span className="text-sm text-foreground truncate flex-1">{item.title}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {item.repo.split('/')[1]}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Weekly review */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Weekly Review</h3>
          {carryOverCount > 0 && (
            <button
              type="button"
              onClick={handleCarryOver}
              className="flex items-center gap-1.5 text-xs text-primary hover:bg-primary/10 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <ArrowRight size={13} />
              Carry {carryOverCount} unfinished task{carryOverCount === 1 ? '' : 's'} to today
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[
            { key: 'wellDone', label: '✅ What went well?' },
            { key: 'blockers', label: '🚧 Blockers?' },
            { key: 'next', label: '🎯 Next week priorities' }
          ].map(({ key, label }) => (
            <div key={key}>
              <label
                htmlFor={`weekly-reflection-${key}`}
                className="text-xs text-muted-foreground font-medium mb-1.5 block"
              >
                {label}
              </label>
              <textarea
                id={`weekly-reflection-${key}`}
                value={reflection[key as keyof typeof reflection]}
                onChange={(e) => saveReflection({ ...reflection, [key]: e.target.value })}
                placeholder="Write here…"
                className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary resize-none min-h-[100px]"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
