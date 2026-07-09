/**
 * Year scrubber + month drill-down (Timeline 2.0, PR 4) — navigation across a
 * 36-year archive in two clicks. A density strip of per-year bars (from
 * records:histogram) jumps to a year; a month grid (per-month counts within
 * that year) narrows to a month. Selection is expressed as a UTC epoch-ms
 * range the parent feeds into records:list.
 */

import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type TimelineRange = { from: number; to: number; label: string } | null

/** UTC year range, inclusive ms bounds. */
function yearRange(year: number): { from: number; to: number } {
  return {
    from: Date.UTC(year, 0, 1),
    to: Date.UTC(year + 1, 0, 1) - 1
  }
}

function monthRange(year: number, month0: number): { from: number; to: number } {
  return {
    from: Date.UTC(year, month0, 1),
    to: Date.UTC(year, month0 + 1, 1) - 1
  }
}

export function YearScrubber({
  range,
  onRangeChange,
  includeFirehose
}: {
  range: TimelineRange
  onRangeChange: (range: TimelineRange) => void
  includeFirehose: boolean
}): JSX.Element | null {
  const [years, setYears] = useState<Array<{ year: number; count: number }>>([])
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [months, setMonths] = useState<Array<{ month0: number; count: number }>>([])
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null)

  useEffect(() => {
    if (!isElectron()) return
    void window.api.records
      .histogram({ bucket: 'year', includeFirehose })
      .then((buckets) =>
        setYears(
          buckets
            .map((b) => ({ year: Number(b.bucket), count: b.count }))
            .filter((b) => Number.isFinite(b.year))
        )
      )
      .catch(() => setYears([]))
  }, [includeFirehose])

  // Month counts for the selected year (its UTC range keeps the buckets to 12).
  useEffect(() => {
    if (!isElectron() || selectedYear == null) {
      setMonths([])
      return
    }
    const r = yearRange(selectedYear)
    void window.api.records
      .histogram({ bucket: 'month', from: r.from, to: r.to, includeFirehose })
      .then((buckets) =>
        setMonths(
          buckets
            .map((b) => ({ month0: Number(b.bucket.slice(5)) - 1, count: b.count }))
            .filter((b) => b.month0 >= 0 && b.month0 < 12)
        )
      )
      .catch(() => setMonths([]))
  }, [selectedYear, includeFirehose])

  // When the parent clears the range (e.g. a search started), reset the scrubber.
  useEffect(() => {
    if (range === null) {
      setSelectedYear(null)
      setSelectedMonth(null)
    }
  }, [range])

  if (years.length < 2) return null

  const max = Math.max(...years.map((y) => y.count), 1)

  function pickYear(year: number): void {
    if (selectedYear === year) {
      setSelectedYear(null)
      setSelectedMonth(null)
      onRangeChange(null)
      return
    }
    setSelectedYear(year)
    setSelectedMonth(null)
    onRangeChange({ ...yearRange(year), label: String(year) })
  }

  function pickMonth(month0: number): void {
    if (selectedYear == null) return
    if (selectedMonth === month0) {
      setSelectedMonth(null)
      onRangeChange({ ...yearRange(selectedYear), label: String(selectedYear) })
      return
    }
    setSelectedMonth(month0)
    onRangeChange({
      ...monthRange(selectedYear, month0),
      label: `${MONTHS[month0]} ${selectedYear}`
    })
  }

  const monthCount = new Map(months.map((m) => [m.month0, m.count]))

  return (
    <div className="mb-4">
      <div className="flex items-end gap-1 overflow-x-auto pb-1" aria-label="Jump to a year">
        {years.map(({ year, count }) => (
          <button
            key={year}
            type="button"
            onClick={() => pickYear(year)}
            title={`${year} · ${count.toLocaleString()} records`}
            aria-pressed={selectedYear === year}
            className={cn(
              'flex flex-col items-center gap-1 px-1.5 py-1 rounded-md border transition-colors shrink-0',
              selectedYear === year
                ? 'border-primary/50 bg-primary/10'
                : 'border-transparent hover:border-border hover:bg-secondary'
            )}
          >
            {/* Density bar — height scales to the busiest year. */}
            <span className="relative w-4 h-8 rounded-sm bg-secondary overflow-hidden">
              <span
                className={cn(
                  'absolute bottom-0 left-0 right-0 rounded-sm',
                  selectedYear === year ? 'bg-primary' : 'bg-primary/50'
                )}
                style={{ height: `${Math.max(6, Math.round((count / max) * 100))}%` }}
              />
            </span>
            <span
              className={cn(
                'text-[10px] tabular-nums',
                selectedYear === year ? 'text-primary font-semibold' : 'text-muted-foreground'
              )}
            >
              {String(year).slice(2)}
            </span>
          </button>
        ))}
      </div>

      {selectedYear != null && (
        <div className="grid grid-cols-6 sm:grid-cols-12 gap-1 mt-2" aria-label="Jump to a month">
          {MONTHS.map((m, i) => {
            const count = monthCount.get(i) ?? 0
            return (
              <button
                key={m}
                type="button"
                onClick={() => pickMonth(i)}
                disabled={count === 0}
                title={
                  count > 0
                    ? `${m} ${selectedYear} · ${count.toLocaleString()} records`
                    : `${m} ${selectedYear} · empty`
                }
                aria-pressed={selectedMonth === i}
                className={cn(
                  'text-[11px] py-1 rounded border transition-colors tabular-nums',
                  selectedMonth === i
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : count > 0
                      ? 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
                      : 'border-border/40 text-muted-foreground/40 cursor-default'
                )}
              >
                {m}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
