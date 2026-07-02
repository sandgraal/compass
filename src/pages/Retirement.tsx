import { PiggyBank, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useToast } from '../components/ui/Toast'
import { formatMoney } from '../lib/money'
import { cn } from '../lib/utils'

type PlanData = Awaited<ReturnType<Window['api']['finance']['getRetirementPlan']>>

// Plan-basics fields → the legacy config (setRetirementConfig). Plain dollars/years.
const BASIC_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'currentAge', label: 'Current age' },
  { key: 'retirementAge', label: 'Retirement age' },
  { key: 'horizonAge', label: 'Plan to age' },
  { key: 'annualSpending', label: "Annual spending (today's $)" },
  { key: 'annualContribution', label: 'Annual extra savings' },
  { key: 'ssMonthlyAtFra', label: 'SS monthly at FRA' },
  { key: 'ssClaimAge', label: 'SS claim age (62–70)' },
  { key: 'fra', label: 'Full retirement age' },
  { key: 'airbnbAnnualNet', label: 'Airbnb net / yr' },
  { key: 'otherAnnualIncome', label: 'Other income / yr' }
]

// Engine assumptions → setRetirementEngineConfig. `pct` fields are shown ×100 and
// divided by 100 on save (the engine stores decimals, e.g. 0.085).
const ENGINE_FIELDS: Array<{ key: string; label: string; pct?: boolean; step?: string }> = [
  { key: 'meanReturn', label: 'Return while saving (%)', pct: true, step: '0.1' },
  { key: 'postRetireReturn', label: 'Return in retirement (%)', pct: true, step: '0.1' },
  { key: 'stdDev', label: 'Volatility σ (%)', pct: true, step: '0.1' },
  { key: 'inflationRate', label: 'US inflation (%)', pct: true, step: '0.1' },
  { key: 'crInflationRate', label: 'CR inflation (%)', pct: true, step: '0.1' },
  { key: 'ssColaRate', label: 'SS COLA (%)', pct: true, step: '0.1' },
  { key: 'medicalInflationRate', label: 'Medical inflation (%)', pct: true, step: '0.1' },
  { key: 'salary', label: 'Salary (pre-retirement)' },
  { key: 'k401ContribPct', label: '401k contribution (% salary)', pct: true, step: '1' },
  { key: 'employerMatchPct', label: 'Employer match (%)', pct: true, step: '0.5' },
  { key: 'cajaMonthly', label: 'CAJA / mo' },
  { key: 'privateMonthly', label: 'Private health / mo' },
  { key: 'ltcMonthly', label: 'LTC / mo' },
  { key: 'ltcStartAge', label: 'LTC start age' },
  { key: 'ltcYears', label: 'LTC years' },
  { key: 'lifeExpectancy', label: 'Life expectancy' },
  { key: 'condoValue', label: 'Home value' },
  { key: 'condoPurchasePrice', label: 'Home purchase price' },
  { key: 'primaryResidenceSince', label: 'Owned since (year)' },
  { key: 'condoSaleYear', label: 'Planned sale year' }
]

const pctDisplay = (v: number): string => String(Math.round(v * 10000) / 100)

function Tile({
  label,
  value,
  sub,
  tone
}: {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'warn' | 'bad'
}): JSX.Element {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold',
          tone === 'good' && 'text-emerald-500',
          tone === 'warn' && 'text-amber-500',
          tone === 'bad' && 'text-destructive',
          !tone && 'text-foreground'
        )}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

export default function Retirement(): JSX.Element {
  const [data, setData] = useState<PlanData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [filingStatus, setFilingStatus] = useState<'single' | 'mfj'>('single')
  const [ltcEnabled, setLtcEnabled] = useState(false)
  const [startingOverride, setStartingOverride] = useState('')
  const { toast: showToast } = useToast()

  const refresh = useCallback(async () => {
    if (!window.api?.finance) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const r = await window.api.finance.getRetirementPlan()
      setData(r)
      const f: Record<string, string> = {}
      const cfg = r.config as unknown as Record<string, number>
      for (const fd of BASIC_FIELDS) f[fd.key] = String(cfg[fd.key])
      const eng = r.engineConfig as unknown as Record<string, number>
      for (const fd of ENGINE_FIELDS)
        f[fd.key] = fd.pct ? pctDisplay(eng[fd.key]) : String(eng[fd.key])
      setForm(f)
      setFilingStatus(r.engineConfig.filingStatus)
      setLtcEnabled(r.engineConfig.ltcEnabled)
      setStartingOverride(r.config.startingAssets != null ? String(r.config.startingAssets) : '')
    } catch (err) {
      console.error('[retirement] refresh failed', err)
      showToast('Failed to load retirement plan.', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (): Promise<void> => {
    if (!window.api?.finance) return
    setSaving(true)
    try {
      // Plan basics → legacy config.
      const basic: Record<string, number | null> = {}
      for (const fd of BASIC_FIELDS) {
        const raw = form[fd.key]
        if (raw === undefined || raw.trim() === '') continue
        const v = Number(raw)
        if (Number.isFinite(v)) basic[fd.key] = v
      }
      basic.startingAssets = startingOverride.trim() === '' ? null : Number(startingOverride)
      if (basic.startingAssets != null && !Number.isFinite(basic.startingAssets)) {
        basic.startingAssets = null
      }

      // Engine assumptions → engine config.
      const engine: Record<string, number | string | boolean> = {
        filingStatus,
        ltcEnabled
      }
      for (const fd of ENGINE_FIELDS) {
        const raw = form[fd.key]
        if (raw === undefined || raw.trim() === '') continue
        const v = Number(raw)
        if (!Number.isFinite(v)) continue
        engine[fd.key] = fd.pct ? v / 100 : v
      }

      // Sequential (not Promise.all): the two setters touch different config
      // stores, so a partial save is possible. Refresh after ANY outcome so the
      // form always reflects what actually persisted, never a stale in-between.
      const r1 = await window.api.finance.setRetirementConfig(basic)
      const r2 = await window.api.finance.setRetirementEngineConfig(engine)
      await refresh()
      if (!r1.success || !r2.success) {
        showToast(r1.error ?? r2.error ?? 'Failed to save.', 'error')
        return
      }
      showToast('Saved.', 'success')
    } catch (err) {
      console.error('[retirement] save failed', err)
      showToast('Failed to save.', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="p-8 pt-14 text-sm text-muted-foreground">Loading retirement plan…</p>
  }
  if (!data) {
    return (
      <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
        <h1 className="text-xl font-semibold text-foreground mb-2">Retirement</h1>
        <p className="text-sm text-muted-foreground">
          Retirement plan unavailable (this view needs the desktop app).
        </p>
      </div>
    )
  }

  const base = data.baseCurrency
  const fmt = (n: number): string => formatMoney(n, base, { decimals: 0 })
  const { plan, monteCarlo } = data

  // Monte-Carlo success rate (0–100).
  const success = Number.parseFloat(monteCarlo.successRate)
  const successTone: 'good' | 'warn' | 'bad' =
    success >= 85 ? 'good' : success >= 65 ? 'warn' : 'bad'

  // Deterministic depletion age from the tax-aware projection (first depleted row).
  const depleted = plan.projection.find((r) => r.depleted) ?? null
  const swrTone: 'good' | 'warn' | 'bad' =
    plan.swr.status === 'safe' ? 'good' : plan.swr.status === 'caution' ? 'warn' : 'bad'

  // Chart: overlay the deterministic plan balance with the Monte-Carlo p10/p50/p90
  // fan, keyed on age (both start at the retirement age).
  const byAge = new Map<
    number,
    { age: number; plan?: number; p10?: number; p50?: number; p90?: number }
  >()
  const put = (
    age: number,
    patch: Partial<{ plan: number; p10: number; p50: number; p90: number }>
  ): void => {
    byAge.set(age, { age, ...byAge.get(age), ...patch })
  }
  for (const r of plan.projection) put(r.age, { plan: Math.round(r.balance) })
  if (monteCarlo.paths) {
    for (const pt of monteCarlo.paths.p10) put(pt.age, { p10: Math.round(pt.value) })
    for (const pt of monteCarlo.paths.p50) put(pt.age, { p50: Math.round(pt.value) })
    for (const pt of monteCarlo.paths.p90) put(pt.age, { p90: Math.round(pt.value) })
  }
  const chartData = [...byAge.values()].sort((a, b) => a.age - b.age)

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PiggyBank size={20} className="text-primary" />
          <h1 className="text-xl font-semibold text-foreground">Retirement</h1>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="bg-card border border-border rounded-lg px-4 py-3 text-xs text-muted-foreground">
        A Monte-Carlo, tax-aware projection seeded from your net worth (retirement + savings).
        Estimates only — your assumptions drive everything.{' '}
        {data.hasSsaStatement
          ? "You've ingested an SSA statement — enter your monthly benefit at full retirement age from it below."
          : 'Enter your monthly Social Security benefit at full retirement age (from ssa.gov) below.'}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Tile
          label="Success rate"
          value={`${monteCarlo.successRate}%`}
          sub="Monte Carlo"
          tone={successTone}
        />
        <Tile
          label="Starting assets"
          value={fmt(data.startingAssets)}
          sub={data.config.startingAssets == null ? 'from net worth' : 'manual override'}
        />
        <Tile
          label="Safe withdrawal"
          value={plan.swr.swr === '—' ? '—' : `${plan.swr.swr}%`}
          sub={`${plan.swr.status} · safe ≤ ${plan.swr.safeThreshold}%`}
          tone={swrTone}
        />
        <Tile
          label="Outcome"
          value={depleted ? `Depletes at ${depleted.age}` : `Lasts to ${data.config.horizonAge}`}
          tone={depleted ? 'bad' : 'good'}
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="text-sm font-semibold mb-3">
          Portfolio balance by age ({base}) — plan vs Monte-Carlo range
        </h3>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
              <defs>
                <linearGradient id="mcBand" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="age"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                tickMargin={6}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={(v) =>
                  formatMoney(v as number, base, { decimals: 0, compact: true })
                }
                width={70}
              />
              <Tooltip
                formatter={(v) => fmt(Number(v))}
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: 12
                }}
              />
              <ReferenceLine
                x={data.config.retirementAge}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
              />
              {/* p90 shaded region + p10 downside line frame the Monte-Carlo spread */}
              <Area
                type="monotone"
                dataKey="p90"
                name="90th pct"
                stroke="none"
                fill="url(#mcBand)"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p10"
                name="10th pct"
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="Median"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="plan"
                name="Plan"
                stroke="hsl(var(--foreground))"
                strokeWidth={1.5}
                strokeDasharray="2 3"
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Dashed vertical = retirement age. Shaded = up to the 90th percentile; dashed line = 10th
          percentile (downside); solid = median; dotted = the deterministic plan.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold">Plan basics</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {BASIC_FIELDS.map((fd) => (
            <label key={fd.key} className="text-xs text-muted-foreground">
              <span className="block mb-1">{fd.label}</span>
              <input
                type="number"
                value={form[fd.key] ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, [fd.key]: e.target.value }))}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
              />
            </label>
          ))}
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Starting assets override</span>
            <input
              type="number"
              value={startingOverride}
              onChange={(e) => setStartingOverride(e.target.value)}
              placeholder={`auto: ${fmt(data.startingAssets)}`}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
            />
          </label>
        </div>

        <h3 className="text-sm font-semibold pt-2">Engine assumptions</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Filing status</span>
            <select
              value={filingStatus}
              onChange={(e) => setFilingStatus(e.target.value === 'mfj' ? 'mfj' : 'single')}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
            >
              <option value="single">Single</option>
              <option value="mfj">Married filing jointly</option>
            </select>
          </label>
          {ENGINE_FIELDS.map((fd) => (
            <label key={fd.key} className="text-xs text-muted-foreground">
              <span className="block mb-1">{fd.label}</span>
              <input
                type="number"
                step={fd.step ?? '1'}
                value={form[fd.key] ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, [fd.key]: e.target.value }))}
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-muted-foreground self-end pb-1">
            <input
              type="checkbox"
              checked={ltcEnabled}
              onChange={(e) => setLtcEnabled(e.target.checked)}
              className="accent-[hsl(var(--primary))]"
            />
            <span>Model a late-life long-term-care shock</span>
          </label>
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Apply & recompute'}
          </button>
        </div>
      </div>
    </div>
  )
}
