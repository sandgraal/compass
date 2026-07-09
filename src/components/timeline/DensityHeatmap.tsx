/**
 * Density heatmap (Timeline 2.0, PR 5) — the whole archive at a glance: one
 * row per year, one cell per month, intensity = record volume (√-scaled so a
 * 37k-record year doesn't flatten every earlier era to invisible). One
 * records:histogram(month) call paints the entire grid; clicking a cell
 * drills into Browse for that month.
 */

import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Intensity buckets: index = ceil(√(count/max) × 4), so mid-volume months stay
// visibly distinct from empty ones even next to a massive recent year.
const LEVEL_CLASS = [
  'bg-secondary',
  'bg-primary/20',
  'bg-primary/45',
  'bg-primary/70',
  'bg-primary'
]

export function DensityHeatmap({
  onPickMonth
}: {
  /** Drill into Browse for one month (year, 0-based month). */
  onPickMonth: (year: number, month0: number) => void
}): JSX.Element {
  const [cells, setCells] = useState<Map<string, number> | null>(null)

  useEffect(() => {
    if (!isElectron()) {
      setCells(new Map())
      return
    }
    void window.api.records
      .histogram({ bucket: 'month' })
      .then((buckets) => setCells(new Map(buckets.map((b) => [b.bucket, b.count]))))
      .catch(() => setCells(new Map()))
  }, [])

  if (cells === null) {
    return <div className="rounded-xl border border-border bg-card h-64 animate-pulse" />
  }
  if (cells.size === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Nothing dated on the timeline yet.
      </p>
    )
  }

  const years: number[] = []
  let max = 1
  for (const [key, count] of cells) {
    const year = Number(key.slice(0, 4))
    if (!years.includes(year)) years.push(year)
    if (count > max) max = count
  }
  years.sort((a, b) => b - a) // newest era on top

  return (
    <div className="rounded-xl border border-border bg-card p-4 overflow-x-auto">
      <div className="min-w-[420px]">
        <div className="grid grid-cols-[3rem_repeat(12,1fr)] gap-1 mb-1.5">
          <span />
          {MONTHS.map((m) => (
            <span key={m} className="text-[10px] text-muted-foreground text-center">
              {m}
            </span>
          ))}
        </div>
        <div className="space-y-1">
          {years.map((year) => (
            <div key={year} className="grid grid-cols-[3rem_repeat(12,1fr)] gap-1 items-stretch">
              <span className="text-[11px] text-muted-foreground tabular-nums self-center">
                {year}
              </span>
              {MONTHS.map((m, month0) => {
                const key = `${year}-${String(month0 + 1).padStart(2, '0')}`
                const count = cells.get(key) ?? 0
                const level =
                  count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count / max) * 4)))
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={count === 0}
                    onClick={() => onPickMonth(year, month0)}
                    title={
                      count > 0
                        ? `${m} ${year} · ${count.toLocaleString()} records`
                        : `${m} ${year} · empty`
                    }
                    aria-label={`${m} ${year}: ${count} records`}
                    className={cn(
                      'h-5 rounded-[4px] transition-all',
                      LEVEL_CLASS[level],
                      count > 0
                        ? 'hover:ring-2 hover:ring-primary cursor-pointer'
                        : 'cursor-default'
                    )}
                  />
                )
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-3">
          <span className="text-[10px] text-muted-foreground">Less</span>
          {LEVEL_CLASS.map((c) => (
            <span key={c} className={cn('w-3.5 h-3.5 rounded-[3px]', c)} />
          ))}
          <span className="text-[10px] text-muted-foreground">More</span>
        </div>
      </div>
    </div>
  )
}
