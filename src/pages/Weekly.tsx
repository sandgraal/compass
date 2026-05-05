import { useState, useEffect, useRef, useCallback } from 'react'
import { format, startOfWeek, endOfWeek, eachDayOfInterval, addWeeks, subWeeks, isSameDay } from 'date-fns'
import { ChevronLeft, ChevronRight, CheckSquare, GitBranch, Calendar } from 'lucide-react'
import { cn, isoDate } from '../lib/utils'

export default function Weekly(): JSX.Element {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [allItems, setAllItems] = useState<Record<string, ChecklistItem[]>>({})
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [githubItems, setGithubItems] = useState<GitHubItem[]>([])
  const [goals, setGoals] = useState(['', '', ''])
  const [reflection, setReflection] = useState({ wellDone: '', blockers: '', next: '' })

  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd })
  const isCurrentWeek = isSameDay(weekStart, startOfWeek(new Date(), { weekStartsOn: 1 }))
  const weekKey = isoDate(weekStart)

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return

    // Load checklist + calendar + github + persisted goals/reflection
    Promise.all([
      ...days.map(d => window.api.checklist.getItems('daily', isoDate(d))),
      window.api.calendar.getEvents(weekStart.toISOString(), weekEnd.toISOString()),
      window.api.github.getItems('open'),
      window.api.settings.getAll()
    ]).then((results) => {
      const itemResults = results.slice(0, 7) as ChecklistItem[][]
      const itemMap: Record<string, ChecklistItem[]> = {}
      days.forEach((d, i) => { itemMap[isoDate(d)] = itemResults[i] })
      setAllItems(itemMap)
      setEvents(results[7] as CalendarEvent[])
      setGithubItems(results[8] as GitHubItem[])

      const s = results[9] as Record<string, string>
      const savedGoals = s[`weekly_goals_${weekKey}`]
      const savedReflection = s[`weekly_reflection_${weekKey}`]
      try { if (savedGoals) setGoals(JSON.parse(savedGoals)) } catch { /* ignore corrupt data */ }
      try { if (savedReflection) setReflection(JSON.parse(savedReflection)) } catch { /* ignore corrupt data */ }
    })
  }, [weekStart])

  const goalsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reflectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (goalsTimerRef.current) clearTimeout(goalsTimerRef.current)
      if (reflectionTimerRef.current) clearTimeout(reflectionTimerRef.current)
    }
  }, [])

  const saveGoals = useCallback((newGoals: string[]) => {
    setGoals(newGoals)
    if (!window.api) return
    if (goalsTimerRef.current) clearTimeout(goalsTimerRef.current)
    goalsTimerRef.current = setTimeout(() => {
      window.api.settings.set(`weekly_goals_${weekKey}`, JSON.stringify(newGoals))
    }, 500)
  }, [weekKey])

  const saveReflection = useCallback((newReflection: typeof reflection) => {
    setReflection(newReflection)
    if (!window.api) return
    if (reflectionTimerRef.current) clearTimeout(reflectionTimerRef.current)
    reflectionTimerRef.current = setTimeout(() => {
      window.api.settings.set(`weekly_reflection_${weekKey}`, JSON.stringify(newReflection))
    }, 500)
  }, [weekKey])

  const totalTasks = Object.values(allItems).flat().length
  const completedTasks = Object.values(allItems).flat().filter(i => i.checked).length
  const completionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setWeekStart(subWeeks(weekStart, 1))} className="p-1.5 rounded hover:bg-secondary transition-colors">
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
          <button onClick={() => setWeekStart(addWeeks(weekStart, 1))} className="p-1.5 rounded hover:bg-secondary transition-colors">
            <ChevronRight size={16} />
          </button>
          {!isCurrentWeek && (
            <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))} className="text-xs text-primary hover:underline">
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
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${completionPct}%` }} />
            </div>
            <span>{completionPct}%</span>
          </div>
        </div>
      </div>

      {/* 7-day grid */}
      <div className="grid grid-cols-7 gap-3 mb-8">
        {days.map((day) => {
          const dayItems = allItems[isoDate(day)] || []
          const done = dayItems.filter(i => i.checked).length
          const isToday = isSameDay(day, new Date())
          return (
            <div key={isoDate(day)} className={cn(
              'bg-card border rounded-xl p-3',
              isToday ? 'border-primary/50' : 'border-border'
            )}>
              <div className={cn('text-xs font-medium mb-2', isToday ? 'text-primary' : 'text-muted-foreground')}>
                <div>{format(day, 'EEE')}</div>
                <div className={cn('text-lg font-semibold mt-0.5', isToday ? 'text-primary' : 'text-foreground')}>
                  {format(day, 'd')}
                </div>
              </div>
              {dayItems.length === 0 ? (
                <p className="text-xs text-muted-foreground/40">No tasks</p>
              ) : (
                <div>
                  <div className="space-y-1 mb-2">
                    {dayItems.slice(0, 3).map(item => (
                      <div key={item.id} className="flex items-center gap-1.5">
                        <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', item.checked ? 'bg-primary' : 'bg-border')} />
                        <span className={cn('text-xs truncate', item.checked && 'line-through text-muted-foreground')}>{item.title}</span>
                      </div>
                    ))}
                    {dayItems.length > 3 && (
                      <p className="text-xs text-muted-foreground/60">+{dayItems.length - 3} more</p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{done}/{dayItems.length}</p>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Two-column: Goals + GitHub */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><CheckSquare size={14} /> Weekly Goals</h3>
          <div className="space-y-2">
            {goals.map((goal, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="w-5 h-5 rounded border border-border shrink-0 flex items-center justify-center text-xs text-muted-foreground">{i + 1}</div>
                <input
                  value={goal}
                  onChange={(e) => saveGoals(goals.map((g, j) => j === i ? e.target.value : g))}
                  placeholder={`Goal ${i + 1}…`}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><GitBranch size={14} /> Open Issues</h3>
          {githubItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open issues.</p>
          ) : (
            <div className="space-y-2">
              {githubItems.slice(0, 5).map(item => (
                <div key={item.id} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <span className="text-sm text-foreground truncate flex-1">{item.title}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{item.repo.split('/')[1]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Weekly review */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-semibold mb-4">Weekly Review</h3>
        <div className="grid grid-cols-3 gap-4">
          {[
            { key: 'wellDone', label: '✅ What went well?' },
            { key: 'blockers', label: '🚧 Blockers?' },
            { key: 'next', label: '🎯 Next week priorities' }
          ].map(({ key, label }) => (
            <div key={key}>
              <label className="text-xs text-muted-foreground font-medium mb-1.5 block">{label}</label>
              <textarea
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
