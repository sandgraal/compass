import { useState, useEffect, useRef, useCallback } from 'react'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, isSameMonth, isSameDay, addMonths, subMonths } from 'date-fns'
import { ChevronLeft, ChevronRight, Target, TrendingUp, Plus, X, DollarSign } from 'lucide-react'
import { cn, isoDate } from '../lib/utils'

const HABIT_COLORS = ['#6272f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899']

export default function Monthly(): JSX.Element {
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [habits, setHabits] = useState<Habit[]>([])
  const [habitEntries, setHabitEntries] = useState<Record<number, Record<string, boolean>>>({})
  const [goals, setGoals] = useState(['', '', ''])
  const [reflection, setReflection] = useState({ win: '', challenge: '', focus: '' })
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [addingHabit, setAddingHabit] = useState(false)
  const [newHabitName, setNewHabitName] = useState('')
  const [debtSummary, setDebtSummary] = useState<{ id: number; name: string; balance: number | null; apr: number | null }[]>([])
  const [budgetLines, setBudgetLines] = useState<{ category: string; budget: number; actual: number }[]>([])

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
      window.api.settings.getAll(),
      window.api.habits.list(),
      window.api.habits.getEntries(monthKey),
      window.api.finance.getDebtSummary().catch(() => ({ debts: [] })),
      window.api.finance.getBudgetStatus(monthKey).catch(() => ({ lines: [], totals: { budget: 0, actual: 0 } }))
    ]).then(([calEvents, s, habitList, entries, debtData, budgetData]) => {
      setEvents(calEvents)
      setHabits(habitList)
      setHabitEntries(entries)

      // Finance snapshot
      const d = debtData as { debts: { id: number; name: string; balance: number | null; apr: number | null }[] }
      setDebtSummary(d.debts.filter(x => (x.balance ?? 0) !== 0))
      const b = budgetData as { lines: { category: string; budget: number; actual: number }[]; totals: { budget: number; actual: number } }
      setBudgetLines(b.lines.filter(l => l.budget > 0 || Math.abs(l.actual) > 0).slice(0, 4))

      const settings = s as Record<string, string>
      const savedGoals = settings[`monthly_goals_${monthKey}`]
      const savedReflection = settings[`monthly_reflection_${monthKey}`]
      try { if (savedGoals) setGoals(JSON.parse(savedGoals)) } catch { /* ignore corrupt data */ }
      try { if (savedReflection) setReflection(JSON.parse(savedReflection)) } catch { /* ignore corrupt data */ }
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

  async function toggleHabit(habitId: number, date: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    const { completed } = await window.api.habits.toggle(habitId, date)
    setHabitEntries(prev => ({
      ...prev,
      [habitId]: { ...(prev[habitId] ?? {}), [date]: completed }
    }))
  }

  async function addHabit() {
    const name = newHabitName.trim()
    if (!name || !window.api) return
    const color = HABIT_COLORS[habits.length % HABIT_COLORS.length]
    const { id } = await window.api.habits.create({ name, color })
    setHabits(prev => [...prev, { id, name, icon: null, color, active: true, createdAt: new Date() }])
    setNewHabitName('')
    setAddingHabit(false)
  }

  async function removeHabit(id: number) {
    if (!window.api) return
    await window.api.habits.delete(id)
    setHabits(prev => prev.filter(h => h.id !== id))
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

          {/* Financial snapshot */}
          {(debtSummary.length > 0 || budgetLines.length > 0) && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-emerald-400">
                <DollarSign size={14} /> Finance
              </h3>
              {debtSummary.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs text-muted-foreground font-medium mb-1.5 uppercase tracking-wider">Debt</p>
                  <div className="space-y-1.5">
                    {debtSummary.map(d => (
                      <div key={d.id} className="flex items-center justify-between">
                        <span className="text-xs text-foreground truncate flex-1 mr-2">{d.name}</span>
                        <span className="text-xs font-mono text-red-400 shrink-0">
                          ${Math.abs(d.balance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 0 })}
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between border-t border-border pt-1.5 mt-1">
                      <span className="text-xs text-muted-foreground">Total debt</span>
                      <span className="text-xs font-mono font-semibold text-red-400">
                        ${debtSummary.reduce((s, d) => s + Math.abs(d.balance ?? 0), 0).toLocaleString('en-US', { minimumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {budgetLines.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1.5 uppercase tracking-wider">Budget vs Actual</p>
                  <div className="space-y-1.5">
                    {budgetLines.map(l => {
                      const over = l.actual > l.budget && l.budget > 0
                      return (
                        <div key={l.category}>
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs text-foreground capitalize">{l.category}</span>
                            <span className={cn('text-xs font-mono', over ? 'text-red-400' : 'text-muted-foreground')}>
                              ${Math.abs(l.actual).toFixed(0)} / ${l.budget.toFixed(0)}
                            </span>
                          </div>
                          {l.budget > 0 && (
                            <div className="h-1 bg-secondary rounded-full overflow-hidden">
                              <div
                                className={cn('h-full rounded-full transition-all', over ? 'bg-red-500' : 'bg-emerald-500')}
                                style={{ width: `${Math.min(100, (Math.abs(l.actual) / l.budget) * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {debtSummary.length === 0 && budgetLines.length === 0 && (
                <p className="text-xs text-muted-foreground">No finance data for this month.</p>
              )}
            </div>
          )}
        </div>

        {/* Middle/right columns: habits tracker */}
        <div className="col-span-2 space-y-6">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2"><TrendingUp size={14} /> Habits Tracker</h3>
              <button
                onClick={() => setAddingHabit(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus size={12} /> Add habit
              </button>
            </div>

            {/* Add habit input */}
            {addingHabit && (
              <div className="mb-3 flex items-center gap-2">
                <input
                  autoFocus
                  value={newHabitName}
                  onChange={e => setNewHabitName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addHabit(); if (e.key === 'Escape') { setAddingHabit(false); setNewHabitName('') } }}
                  placeholder="Habit name…"
                  className="flex-1 bg-secondary border border-border rounded px-2 py-1 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
                <button onClick={addHabit} className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded">Add</button>
                <button onClick={() => { setAddingHabit(false); setNewHabitName('') }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
              </div>
            )}

            {habits.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No habits yet. Click "Add habit" to start tracking.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left text-muted-foreground font-medium pb-2 pr-3 w-32">Habit</th>
                      {daysInMonth.map(d => (
                        <th key={isoDate(d)} className={cn(
                          'text-center pb-2 w-6 font-medium',
                          isSameDay(d, today) ? 'text-primary' : 'text-muted-foreground'
                        )}>
                          {format(d, 'd')}
                        </th>
                      ))}
                      <th className="text-center text-muted-foreground font-medium pb-2 pl-2">%</th>
                      <th className="w-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {habits.map((habit) => {
                      const entries = habitEntries[habit.id] || {}
                      const doneCount = daysInMonth.filter(d => entries[isoDate(d)]).length
                      const pct = Math.round((doneCount / daysInMonth.length) * 100)
                      const color = habit.color ?? '#6272f1'
                      return (
                        <tr key={habit.id} className="border-t border-border/40 group">
                          <td className="py-1.5 pr-3 font-medium" style={{ color }}>{habit.name}</td>
                          {daysInMonth.map(d => {
                            const dateStr = isoDate(d)
                            const isFuture = d > today
                            const done = entries[dateStr]
                            return (
                              <td key={dateStr} className="py-1.5 text-center">
                                <button
                                  onClick={() => !isFuture && toggleHabit(habit.id, dateStr)}
                                  disabled={isFuture}
                                  className={cn(
                                    'w-5 h-5 rounded mx-auto transition-colors',
                                    isFuture && 'bg-secondary/20 cursor-default'
                                  )}
                                  style={done ? { backgroundColor: color, opacity: 1 } : !isFuture ? { backgroundColor: 'var(--secondary)', opacity: 0.6 } : undefined}
                                />
                              </td>
                            )
                          })}
                          <td className="py-1.5 text-center text-muted-foreground pl-2">{pct}%</td>
                          <td className="py-1.5 pl-1">
                            <button
                              onClick={() => removeHabit(habit.id)}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                            >
                              <X size={11} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
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
