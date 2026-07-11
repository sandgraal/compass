/**
 * "On this day" hero (Timeline 2.0, PR 4) — the emotional core of the
 * Timeline: every year of your archive that shares one month-day, as a
 * vertical scroll of year-grouped memories. Defaults to today; the ◀ ▶
 * controls and the date picker browse any day of the year. Powered by
 * records:on-this-day-v2 (index-seek on the 0033 mmdd index; firehose
 * excluded server-side).
 */

import {
  Banknote,
  Cake,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Sparkles,
  Store,
  UserPlus
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { RecordRow, memoryTier, sourceMeta } from './timeline-meta'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

type YearGroup = { year: number; count: number; records: TimelineRecord[] }
type Moment = {
  kind: 'birthday' | 'first-met' | 'first-merchant' | 'purchase-anniversary' | 'renewal'
  title: string
  detail?: string
}

const MOMENT_ICON: Record<Moment['kind'], JSX.Element> = {
  birthday: <Cake size={13} />,
  'first-met': <UserPlus size={13} />,
  'first-merchant': <Store size={13} />,
  'purchase-anniversary': <Banknote size={13} />,
  renewal: <RefreshCw size={13} />
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function yearsAgoLabel(yearsAgo: number): string {
  if (yearsAgo <= 0) return 'This year'
  return yearsAgo === 1 ? '1 year ago' : `${yearsAgo} years ago`
}

/**
 * A compact "this date across the years" bar strip above the memory cards —
 * one bar per year that has records on this day, height ∝ count, chronological
 * left→right. Clicking scrolls to that year's card. Only shown once there are
 * enough years to read as a shape.
 */
function YearSparkline({
  years,
  onJump
}: {
  years: YearGroup[]
  onJump: (year: number) => void
}): JSX.Element | null {
  if (years.length < 3) return null
  const chrono = [...years].sort((a, b) => a.year - b.year)
  const max = Math.max(...chrono.map((y) => y.count), 1)
  return (
    <div className="mb-4 flex items-end gap-1" aria-label="Records on this date across the years">
      {chrono.map((y) => (
        <button
          key={y.year}
          type="button"
          onClick={() => onJump(y.year)}
          title={`${y.year} · ${y.count} record${y.count === 1 ? '' : 's'}`}
          className="group flex-1 flex flex-col items-center gap-1 min-w-0"
        >
          <span
            className="w-full rounded-sm bg-primary/40 group-hover:bg-primary transition-colors"
            style={{ height: `${Math.max(4, Math.round((y.count / max) * 36))}px` }}
          />
          <span className="text-[9px] text-muted-foreground tabular-nums">
            {String(y.year).slice(2)}
          </span>
        </button>
      ))}
    </div>
  )
}

export function OnThisDayHero({
  onOpenRecord,
  onOpenDay,
  refreshKey = 0
}: {
  onOpenRecord: (record: TimelineRecord) => void
  /** Drill into one specific UTC day ('YYYY-MM-DD') in Browse mode. */
  onOpenDay: (day: string) => void
  /** Bump to refetch (e.g. after a mute) without changing the browsed day. */
  refreshKey?: number
}): JSX.Element {
  // The browsed month-day (defaults to today, UTC — the archive's day convention).
  const now = new Date()
  const [month, setMonth] = useState(now.getUTCMonth() + 1)
  const [day, setDay] = useState(now.getUTCDate())
  const [years, setYears] = useState<YearGroup[] | null>(null)
  const [moments, setMoments] = useState<Moment[]>([])
  const [mutedCount, setMutedCount] = useState(0)

  const isToday = month === now.getUTCMonth() + 1 && day === now.getUTCDate()

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey isn't read in the body — it deliberately re-triggers the fetch after a mute changes what should resurface
  useEffect(() => {
    if (!isElectron()) {
      setYears([])
      return
    }
    let stale = false
    void window.api.records
      .onThisDayAllYears({ month, day, perYearCap: 6 })
      .then((groups) => {
        if (!stale) setYears(groups)
      })
      .catch(() => {
        if (!stale) setYears([])
      })
    void window.api.records
      .moments({ month, day })
      .then((m) => {
        if (!stale) setMoments(m)
      })
      .catch(() => {
        if (!stale) setMoments([])
      })
    void window.api.records
      .mutes()
      .then((m) => {
        if (!stale) setMutedCount(m.length)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [month, day, refreshKey])

  async function restoreMuted(): Promise<void> {
    if (!isElectron()) return
    const snapMonth = month
    const snapDay = day
    const res = await window.api.records.clearMutes()
    if (!res?.success) return

    setYears(null)
    const [groups, mutes, nextMoments] = await Promise.all([
      window.api.records
        .onThisDayAllYears({ month: snapMonth, day: snapDay, perYearCap: 6 })
        .catch(() => []),
      window.api.records.mutes().catch(() => []),
      window.api.records.moments({ month: snapMonth, day: snapDay }).catch(() => [])
    ])

    if (month !== snapMonth || day !== snapDay) return
    setYears(groups)
    setMutedCount(mutes.length)
    setMoments(nextMoments)
  }

  // Step the month-day through the calendar (year-agnostic; leap-safe via a
  // fixed leap reference year so Feb 29 is reachable).
  const step = useCallback(
    (delta: 1 | -1): void => {
      const ref = new Date(Date.UTC(2024, month - 1, day))
      ref.setUTCDate(ref.getUTCDate() + delta)
      setMonth(ref.getUTCMonth() + 1)
      setDay(ref.getUTCDate())
    },
    [month, day]
  )

  const currentYear = now.getUTCFullYear()
  const heading = isToday ? 'On this day' : `On ${MONTH_NAMES[month - 1]} ${day}`

  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={15} className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">{heading}</h2>
        <span className="text-xs text-muted-foreground">
          {MONTH_NAMES[month - 1]} {day}
          {isToday ? ' · today' : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous day"
            title="Previous day"
            className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ChevronLeft size={13} />
          </button>
          {!isToday && (
            <button
              type="button"
              onClick={() => {
                setMonth(now.getUTCMonth() + 1)
                setDay(now.getUTCDate())
              }}
              className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              Today
            </button>
          )}
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next day"
            title="Next day"
            className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      </div>

      {/* Anniversary moments — birthdays, firsts, big-purchase anniversaries,
          today's renewals. Synthetic memories the spine implies. */}
      {moments.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {moments.map((m, i) => (
            <div
              key={`${m.kind}|${m.title}|${m.detail ?? ''}|${i}`}
              className="flex items-center gap-2.5 rounded-xl border border-primary/40 bg-primary/10 px-4 py-2.5"
            >
              <span className="text-primary shrink-0">{MOMENT_ICON[m.kind]}</span>
              <p className="text-sm text-foreground flex-1 min-w-0 truncate">{m.title}</p>
              {m.detail && (
                <span className="text-xs text-muted-foreground shrink-0">{m.detail}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {years === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card h-16 animate-pulse" />
          ))}
        </div>
      ) : years.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-5 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing on {MONTH_NAMES[month - 1]} {day} in any year of your archive — try the next
            day, or import more history.
          </p>
        </div>
      ) : (
        <>
          <YearSparkline
            years={years}
            onJump={(y) =>
              document
                .getElementById(`otd-year-${y}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          />
          {/* Timeline spine down the years, memory cards hanging off each node. */}
          <div className="relative space-y-4 pl-6">
            <span aria-hidden className="absolute left-[7px] top-3 bottom-3 w-px bg-border" />
            {years.map((g, gi) => (
              <div
                key={g.year}
                id={`otd-year-${g.year}`}
                style={{ animationDelay: `${Math.min(gi, 8) * 45}ms` }}
                className="relative rounded-xl border border-primary/25 bg-gradient-to-br from-primary/5 to-transparent px-4 py-3 animate-fade-in"
              >
                <span
                  aria-hidden
                  className="absolute top-5 -left-[1.35rem] w-2.5 h-2.5 rounded-full bg-primary ring-2 ring-background"
                />
                <div className="flex items-baseline gap-2.5 mb-2.5">
                  <span className="text-3xl font-bold text-foreground tabular-nums leading-none">
                    {g.year}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {yearsAgoLabel(currentYear - g.year)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {g.count} record{g.count === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {g.records.map((r) => (
                    <RecordRow
                      key={r.id}
                      record={r}
                      onOpen={onOpenRecord}
                      tier={memoryTier(r.memoryScore)}
                      trailing={
                        <span
                          className="text-xs text-muted-foreground/70 shrink-0"
                          title={sourceMeta(r.source).label}
                        >
                          {sourceMeta(r.source).label}
                        </span>
                      }
                    />
                  ))}
                </div>
                {g.count > g.records.length && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenDay(
                        `${g.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                      )
                    }
                    className="mt-2 text-xs text-primary hover:underline"
                  >
                    See all {g.count} from this day →
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Mutes are reversible — surface the escape hatch wherever they apply. */}
      {mutedCount > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {mutedCount} memor{mutedCount === 1 ? 'y is' : 'ies are'} muted from resurfacing.{' '}
          <button type="button" onClick={restoreMuted} className="text-primary hover:underline">
            Restore all
          </button>
        </p>
      )}
    </section>
  )
}
