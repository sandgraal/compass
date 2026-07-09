/**
 * "On this day" hero (Timeline 2.0, PR 4) — the emotional core of the
 * Timeline: every year of your archive that shares one month-day, as a
 * vertical scroll of year-grouped memories. Defaults to today; the ◀ ▶
 * controls and the date picker browse any day of the year. Powered by
 * records:on-this-day-v2 (index-seek on the 0033 mmdd index; firehose
 * excluded server-side).
 */

import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { RecordRow, sourceMeta } from './timeline-meta'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

type YearGroup = { year: number; count: number; records: TimelineRecord[] }

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

export function OnThisDayHero({
  onOpenRecord,
  onOpenDay
}: {
  onOpenRecord: (record: TimelineRecord) => void
  /** Drill into one specific UTC day ('YYYY-MM-DD') in Browse mode. */
  onOpenDay: (day: string) => void
}): JSX.Element {
  // The browsed month-day (defaults to today, UTC — the archive's day convention).
  const now = new Date()
  const [month, setMonth] = useState(now.getUTCMonth() + 1)
  const [day, setDay] = useState(now.getUTCDate())
  const [years, setYears] = useState<YearGroup[] | null>(null)

  const isToday = month === now.getUTCMonth() + 1 && day === now.getUTCDate()

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
    return () => {
      stale = true
    }
  }, [month, day])

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
        <div className="space-y-4">
          {years.map((g) => (
            <div
              key={g.year}
              className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/5 to-transparent px-4 py-3"
            >
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-sm font-semibold text-foreground">{g.year}</span>
                <span className="text-xs text-muted-foreground">
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
      )}
    </section>
  )
}
