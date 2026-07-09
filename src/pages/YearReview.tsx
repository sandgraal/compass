/**
 * Year in Review (Timeline 2.0, PR 7) — the shareable "wow" every beta tester
 * asked for: one year of the archive as stat tiles, a monthly-activity chart,
 * what you kept returning to, the firsts, the countries, the money, the
 * habits — plus a template narrative and a one-click markdown export into the
 * knowledge base. Data: records:year-review (pure records-year-review.ts).
 */

import { BookmarkPlus, ChevronLeft, ChevronRight, PartyPopper } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { sourceMeta, typeLabel } from '../components/timeline/timeline-meta'
import { useToast } from '../components/ui/Toast'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

export default function YearReview(): JSX.Element {
  const [searchParams] = useSearchParams()
  const currentYear = new Date().getUTCFullYear()
  const seeded = Number(searchParams.get('year'))
  const [year, setYear] = useState(
    Number.isInteger(seeded) && seeded > 1970
      ? seeded
      : currentYear - (new Date().getUTCMonth() < 6 ? 1 : 0)
  )
  const [review, setReview] = useState<YearReviewSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    if (!isElectron()) return
    setLoading(true)
    let stale = false
    void window.api.records
      .yearReview({ year })
      .then((r) => {
        if (!stale) setReview(r)
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [year])

  async function saveToKnowledge(): Promise<void> {
    if (!isElectron()) return
    const md = await window.api.records.yearReviewMarkdown({ year })
    if (!md) {
      toast('Nothing to save for this year', 'error')
      return
    }
    const res = await window.api.knowledge.writeFile(`timeline/year-review-${year}.md`, md)
    if ((res as { success?: boolean })?.success !== false) {
      toast(`Saved to Knowledge · timeline/year-review-${year}.md`, 'success')
    } else {
      toast('Could not save to the knowledge base', 'error')
    }
  }

  const chartData = review
    ? review.monthCounts.map((n, i) => ({ month: MONTHS[i], records: n }))
    : []

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <PartyPopper size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">{year} in Review</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            One year of your archive, distilled — everything computed locally.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setYear((y) => y - 1)}
            aria-label="Previous year"
            title="Previous year"
            className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => setYear((y) => Math.min(currentYear, y + 1))}
            disabled={year >= currentYear}
            aria-label="Next year"
            title="Next year"
            className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            onClick={saveToKnowledge}
            disabled={!review || review.totalRecords === 0}
            className="ml-2 flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50"
          >
            <BookmarkPlus size={14} /> Save to Knowledge
          </button>
        </div>
      </div>

      {loading || !review ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card h-24 animate-pulse" />
          ))}
        </div>
      ) : review.totalRecords === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          No dated records for {year} yet — import more history, or step to another year.
        </p>
      ) : (
        <div className="space-y-6">
          {/* Narrative */}
          <div className="rounded-xl border border-primary/30 bg-primary/5 px-5 py-4">
            <p className="text-sm text-foreground leading-relaxed">{review.narrative}</p>
          </div>

          {/* Stat tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tile label="Records" value={review.totalRecords.toLocaleString()} />
            <Tile
              label="Sources"
              value={String(review.topSources.length)}
              sub={
                review.topSources[0]
                  ? `${sourceMeta(review.topSources[0].source).label} led`
                  : undefined
              }
            />
            <Tile
              label="New people"
              value={String(review.newPeople)}
              sub={review.firsts.find((f) => f.kind === 'person')?.name}
            />
            <Tile
              label="Countries"
              value={String(review.countries.length || 1)}
              sub={review.countries.join(', ') || undefined}
            />
          </div>

          {/* Monthly activity */}
          <div className="bg-card border border-border rounded-xl p-4">
            <h2 className="text-sm font-semibold text-foreground mb-3">Activity by month</h2>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12
                  }}
                />
                <Bar dataKey="records" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* On repeat */}
          {review.topTitles.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">On repeat</h2>
              <div className="space-y-1.5">
                {review.topTitles.map((t) => (
                  <div key={`${t.source}|${t.title}`} className="flex items-center gap-2.5 text-sm">
                    <span
                      className="text-muted-foreground shrink-0"
                      title={sourceMeta(t.source).label}
                    >
                      {sourceMeta(t.source).icon}
                    </span>
                    <span className="text-foreground truncate flex-1">{t.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {typeLabel(t.type)} · {t.count}×
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Firsts */}
          {review.firsts.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">Firsts</h2>
              <div className="flex flex-wrap gap-1.5">
                {review.firsts.map((f) => (
                  <span
                    key={`${f.kind}|${f.name}`}
                    className="text-xs px-2.5 py-1 rounded-full border border-border text-muted-foreground"
                  >
                    {f.name}
                    <span className="text-muted-foreground/60"> · {f.kind}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Money + habits */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {review.spend && (
              <Tile
                label="Total spend"
                value={`$${Math.round(review.spend.total).toLocaleString()}`}
                sub={
                  review.spend.biggest
                    ? `Biggest: ${review.spend.biggest.description} ($${Math.round(review.spend.biggest.amount).toLocaleString()})`
                    : undefined
                }
              />
            )}
            {review.netWorth && review.netWorth.start != null && review.netWorth.end != null && (
              <Tile
                label="Net worth change"
                value={`${review.netWorth.end - review.netWorth.start >= 0 ? '+' : '−'}$${Math.abs(Math.round(review.netWorth.end - review.netWorth.start)).toLocaleString()}`}
              />
            )}
            {review.habits.map((h) => (
              <Tile
                key={h.name}
                label={h.name}
                value={`${h.completions} days`}
                sub="habit completions"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
