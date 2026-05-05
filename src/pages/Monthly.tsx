import { useState, useEffect, useRef, useCallback } from 'react'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths } from 'date-fns'
import { ChevronLeft, ChevronRight, Target, TrendingUp } from 'lucide-react'
import { cn, isoDate } from '../lib/utils'

const DEFAULT_HABITS = ['Exercise', 'Read', 'Meditate', 'No alcohol', 'Sleep 8hrs']

export default function Monthly(): JSX.Element {
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [habits, setHabits] = useState(DEFAULT_HABITS)
  const [habitData, setHabitData] = useState<Record<string, Record<string, boolean>>>({})
  const [goals, setGoals] = useState(['', '', ''])
  const [reflection, setReflection] = useState({ win: '', challenge: '', focus: '' })
  const [events, setEvents] = useState<CalendarEvent[]>([])

  const monthEnd = endOfMonth(month)
  const isCurrentMonth = isSameMonth(month, new Date())
  const monthKey = isoDate(month).slice(0, 7) // 'YYYY-MM'

  // Calendar grid
  const calStart = startOfWeek(month, { weekStartsOn: 1 })
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
  const calDays = eachDayOfInterval({ start: calStart, end: calEnd })
  const daysInMonth = eachDayOfInterval({ start: month, end: monthEnd })

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return

    Promise.all([
      window.api.calendar.getEvents(month.toISOString(), monthEnd.toISOString()),
      window.api.settings.getAll()
    ]).then(([calEvents, s]) => {
      setEvents(calEvents)
      const settings = s as Record<string, string>
      const savedGoals = settings[`monthly_goals_${monthKey}`]
      const savedReflection = settings[`monthly_reflection_${monthKey}`]
      const savedHabits = settings[`monthly_habit_data_${monthKey}`]
      try { if (savedGoals) setGoals(JSON.parse(savedGoals)) } catch { /* ignore corrupt data */ }
      try { if (savedReflection) setReflection(JSON.parse(savedReflection)) } catch { /* ignore corrupt data */ }
      try { if (savedHabits) setHabitData(JSON.parse(savedHabits)) } catch { /* ignore corrupt data */ }
    })
  }, [month])

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
      window.api.settings.set(`monthly_goals_${monthKey}`, JSON.stringify(newGoals))
    }, 500)
  }, [monthKey])

  const saveReflection = useCallback((newReflection: typeof reflection) => {
    setReflection(newReflection)
    if (!window.api) return
    if (reflectionTimerRef.current) clearTimeout(reflectionTimerRef.current)
    reflectionTimerRef.current = setTimeout(() => {
      window.api.settings.set(`monthly_reflection_${monthKey}`, JSON.stringify(newReflection))
    }, 500)
  }, [monthKey])

  function toggleHabit(habit: string, date: string) {
    const newData = {
      ...habitData,
      [habit]: { ...habitData[habit], [date]: !habitData[habit]?.[date] }
    }
    setHabitData(newData)
    if (window.api) window.api.settings.set(`monthly_habit_data_${monthKey}`, JSON.stringify(newData))
  }

  const today = new Date()

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setMonth(subMonths(month, 1))} className="p-1.5 rounded hover:bg-secondary transition-colors">
            <ChevronLeft size={16} />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{format(month, 'MMMM yyyy')}</h1>
            {isCurrentMonth && <p className="text-sm text-muted-foreground">Current month</p>}
          </div>
          <button onClick={() => setMonth(addMonths(month, 1))} className="p-1.5 rounded hover:bg-secondary transition-colors">
            <ChevronRight size={16} />
          </button>
          {!isCurrentMonth && (
            <button onClick={() => setMonth(startOfMonth(new Date()))} className="text-xs text-primary hover:underline">
              This month
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left column: mini calendar + goals */}
        <div className="space-y-6">
          {/* Mini calendar */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="grid grid-cols-7 text-center mb-2">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <div key={i} className="text-xs text-muted-foreground font-medium py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 text-center gap-y-1">
              {calDays.map((day) => {
                const isInMonth = isSameMonth(day, month)
                const isToday = isSameDay(day, today)
                const hasEvent = events.some(e => e.startAt && isSameDay(new Date(e.startAt), day))
                return (
                  <div key={isoDate(day)} className={cn(
                    'text-xs py-1 rounded-full mx-auto w-7 h-7 flex items-center justify-center relative',
                    !isInMonth && 'text-muted-foreground/30',
                    isToday && 'bg-primary text-white font-semibold',
                    !isToday && isInMonth && 'text-foreground hover:bg-secondary cursor-pointer'
                  )}>
                    {format(day, 'd')}
                    {hasEvent && !isToday && (
                      <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary/60" />
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Monthly goals */}
          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Target size={14} /> Monthly Priorities</h3>
            <div className="space-y-2">
              {goals.map((goal, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground w-4">{i + 1}.</span>
                  <input
                    value={goal}
                    onChange={(e) => saveGoals(goals.map((g, j) => j === i ? e.target.value : g))}
                    placeholder={`Priority ${i + 1}…`}
                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Middle column: habits tracker */}
        <div className="col-span-2 space-y-6">
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><TrendingUp size={14} /> Habits Tracker</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left text-muted-foreground font-medium pb-2 pr-4 w-28">Habit</th>
                    {daysInMonth.map(d => (
                      <th key={isoDate(d)} className={cn(
                        'text-center pb-2 w-7 font-medium',
                        isSameDay(d, today) ? 'text-primary' : 'text-muted-foreground'
                      )}>
                        {format(d, 'd')}
                      </th>
                    ))}
                    <th className="text-center text-muted-foreground font-medium pb-2 pl-2">%</th>
                  </tr>
                </thead>
                <tbody>
                  {habits.map((habit) => {
                    const habDays = habitData[habit] || {}
                    const doneCount = daysInMonth.filter(d => habDays[isoDate(d)]).length
                    const pct = Math.round((doneCount / daysInMonth.length) * 100)
                    return (
                      <tr key={habit} className="border-t border-border/40">
                        <td className="py-1.5 pr-4 text-foreground font-medium">{habit}</td>
                        {daysInMonth.map(d => {
                          const dateStr = isoDate(d)
                          const isFuture = d > today
                          const done = habDays[dateStr]
                          return (
                            <td key={dateStr} className="py-1.5 text-center">
                              <button
                                onClick={() => !isFuture && toggleHabit(habit, dateStr)}
                                disabled={isFuture}
                                className={cn(
                                  'w-5 h-5 rounded mx-auto transition-colors',
                                  done ? 'bg-primary' : isFuture ? 'bg-secondary/30' : 'bg-secondary/60 hover:bg-secondary'
                                )}
                              />
                            </td>
                          )
                        })}
                        <td className="py-1.5 text-center text-muted-foreground pl-2">{pct}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Monthly reflection */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">Monthly Reflection</h3>
            <div className="space-y-4">
              {[
                { key: 'win', label: '🏆 Biggest win' },
                { key: 'challenge', label: '💪 Biggest challenge' },
                { key: 'focus', label: '🎯 Focus for next month' }
              ].map(({ key, label }) => (
                <div key={key}>
                  <label className="text-xs text-muted-foreground font-medium mb-1 block">{label}</label>
                  <textarea
                    value={reflection[key as keyof typeof reflection]}
                    onChange={(e) => saveReflection({ ...reflection, [key]: e.target.value })}
                    placeholder="Write here…"
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary resize-none min-h-[72px]"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
