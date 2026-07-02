import { BedDouble, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../components/ui/Toast'
import { formatMoney } from '../lib/money'
import { cn } from '../lib/utils'

type StudioData = Awaited<ReturnType<Window['api']['finance']['getRentalStudio']>>
type StudioUnit = {
  id?: string
  name?: string
  bedrooms?: number
  occupancy?: number
  nightlyOverride?: number
}

const ZONES = [
  'Cartago',
  'Paraíso',
  'Orosi Valley',
  'Tres Ríos',
  'San Rafael Oreamuno',
  'San José',
  'Escazú',
  'Santa Ana',
  'Other'
]

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

export default function RentalStudio(): JSX.Element {
  const [data, setData] = useState<StudioData | null>(null)
  const [loading, setLoading] = useState(true)
  const [units, setUnits] = useState<StudioUnit[]>([])
  const [newComp, setNewComp] = useState({
    name: '',
    zone: 'Cartago',
    bedrooms: '2',
    nightlyUsd: ''
  })
  const { toast: showToast } = useToast()

  const applyData = useCallback((r: StudioData) => {
    setData(r)
    setUnits((r.units as StudioUnit[]) ?? [])
  }, [])

  const refresh = useCallback(async () => {
    if (!window.api?.finance) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      applyData(await window.api.finance.getRentalStudio())
    } catch (err) {
      console.error('[rental-studio] refresh failed', err)
      showToast('Failed to load the rental studio.', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast, applyData])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mutate = useCallback(
    async (input: Record<string, unknown>, okMsg?: string): Promise<void> => {
      if (!window.api?.finance) return
      try {
        const res = await window.api.finance.setRentalStudio(input)
        if (!res.success) {
          showToast(res.error ?? 'Save failed.', 'error')
          return
        }
        if (res.studio) applyData(res.studio as StudioData)
        if (okMsg) showToast(okMsg, 'success')
      } catch (err) {
        console.error('[rental-studio] mutate failed', err)
        showToast('Save failed.', 'error')
      }
    },
    [showToast, applyData]
  )

  const addComp = async (): Promise<void> => {
    const nightly = newComp.nightlyUsd.trim() === '' ? null : Number(newComp.nightlyUsd)
    await mutate(
      {
        addComp: {
          name: newComp.name.trim(),
          zone: newComp.zone,
          bedrooms: Number(newComp.bedrooms) || 2,
          nightlyUsd: nightly != null && Number.isFinite(nightly) ? nightly : null
        }
      },
      'Comp added.'
    )
    setNewComp({ name: '', zone: 'Cartago', bedrooms: '2', nightlyUsd: '' })
  }

  const suggestForUnit = async (idx: number): Promise<void> => {
    if (!window.api?.finance || !data) return
    try {
      const r = await window.api.finance.suggestNightly({
        comps: data.comps as unknown as Array<Record<string, unknown>>,
        listing: { bedrooms: units[idx]?.bedrooms ?? 2 }
      })
      if (r.suggested == null) {
        showToast('Add a few comps first to price from.', 'info')
        return
      }
      setUnits((prev) =>
        prev.map((u, i) => (i === idx ? { ...u, nightlyOverride: r.suggested ?? undefined } : u))
      )
      showToast(`Suggested $${r.suggested}/night (${r.basis}).`, 'success')
    } catch (err) {
      console.error('[rental-studio] suggest failed', err)
    }
  }

  if (loading) {
    return <p className="p-8 pt-14 text-sm text-muted-foreground">Loading rental studio…</p>
  }
  if (!data) {
    return (
      <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
        <h1 className="text-xl font-semibold text-foreground mb-2">CR Rental Studio</h1>
        <p className="text-sm text-muted-foreground">
          Rental studio unavailable (this view needs the desktop app).
        </p>
      </div>
    )
  }

  const base = data.baseCurrency
  const fmt = (n: number): string => formatMoney(n, base, { decimals: 0 })
  const { totals, reconciliation, settings } = data

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BedDouble size={20} className="text-primary" />
          <h1 className="text-xl font-semibold text-foreground">CR Rental Studio</h1>
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

      {/* Reconciliation banner */}
      <div
        className={cn(
          'border rounded-lg px-4 py-3 text-xs',
          reconciliation.actualsNetOperating === 0
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
            : 'bg-card border-border text-muted-foreground'
        )}
      >
        {reconciliation.note}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Tile label="Projected net / yr" value={fmt(totals.annualNet)} sub={`${base}`} />
        <Tile label="Net / mo" value={fmt(totals.monthlyNet)} />
        <Tile label="Gross / yr" value={fmt(totals.annualGross)} />
        <Tile
          label="Actual net op."
          value={
            reconciliation.actualsNetOperating === 0 ? '—' : fmt(reconciliation.actualsNetOperating)
          }
          sub={reconciliation.actualsYear ? `${reconciliation.actualsYear} (tagged)` : 'untagged'}
        />
      </div>

      {/* Units */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Your listing units</h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                setUnits((p) => [
                  ...p,
                  {
                    id: `u${Date.now()}`,
                    name: `Unit ${p.length + 1}`,
                    bedrooms: 2,
                    occupancy: 0.4
                  }
                ])
              }
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-secondary text-foreground hover:bg-secondary/80"
            >
              <Plus size={13} /> Add unit
            </button>
            <button
              type="button"
              onClick={() => void mutate({ units }, 'Units saved.')}
              className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90"
            >
              Save units
            </button>
          </div>
        </div>
        {units.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No units yet — add one, then price it from your comps below.
          </p>
        )}
        {units.map((u, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: units are positional + locally edited
            key={idx}
            className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end border-t border-border pt-3 first:border-t-0 first:pt-0"
          >
            <label className="text-xs text-muted-foreground">
              <span className="block mb-1">Name</span>
              <input
                value={u.name ?? ''}
                onChange={(e) =>
                  setUnits((p) => p.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))
                }
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              <span className="block mb-1">Bedrooms</span>
              <input
                type="number"
                value={u.bedrooms ?? ''}
                onChange={(e) =>
                  setUnits((p) =>
                    p.map((x, i) => (i === idx ? { ...x, bedrooms: Number(e.target.value) } : x))
                  )
                }
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              <span className="block mb-1">Occupancy (0–1)</span>
              <input
                type="number"
                step="0.05"
                value={u.occupancy ?? ''}
                onChange={(e) =>
                  setUnits((p) =>
                    p.map((x, i) => (i === idx ? { ...x, occupancy: Number(e.target.value) } : x))
                  )
                }
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              <span className="block mb-1">Nightly (USD)</span>
              <input
                type="number"
                value={u.nightlyOverride ?? ''}
                onChange={(e) =>
                  setUnits((p) =>
                    p.map((x, i) =>
                      i === idx ? { ...x, nightlyOverride: Number(e.target.value) } : x
                    )
                  )
                }
                className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
              />
            </label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => void suggestForUnit(idx)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-secondary text-foreground hover:bg-secondary/80"
                title="Suggest a nightly price from your comps"
              >
                <Sparkles size={13} /> Suggest
              </button>
              <button
                type="button"
                onClick={() => setUnits((p) => p.filter((_, i) => i !== idx))}
                className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                aria-label="Remove unit"
                title="Remove unit"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Comps */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold">Market comps</h3>
        {data.comps.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No comps yet — add a few nearby listings below.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground text-left border-b border-border">
                  <th className="py-1 pr-2 font-medium">Name</th>
                  <th className="py-1 pr-2 font-medium">Zone</th>
                  <th className="py-1 pr-2 font-medium">BR</th>
                  <th className="py-1 pr-2 font-medium">Nightly</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {data.comps.map((c) => (
                  <tr key={c.id} className="border-b border-border/50">
                    <td className="py-1.5 pr-2 text-foreground">{c.name || '—'}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{c.zone}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{c.bedrooms}</td>
                    <td className="py-1.5 pr-2 text-foreground">
                      {c.nightlyUsd != null ? `$${c.nightlyUsd}` : '—'}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => void mutate({ deleteComp: c.id })}
                        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete comp ${c.name || c.id}`}
                        title="Delete comp"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add comp */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end pt-2">
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Name</span>
            <input
              value={newComp.name}
              onChange={(e) => setNewComp((p) => ({ ...p, name: e.target.value }))}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Zone</span>
            <select
              value={newComp.zone}
              onChange={(e) => setNewComp((p) => ({ ...p, zone: e.target.value }))}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
            >
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Bedrooms</span>
            <input
              type="number"
              value={newComp.bedrooms}
              onChange={(e) => setNewComp((p) => ({ ...p, bedrooms: e.target.value }))}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Nightly (USD)</span>
            <input
              type="number"
              value={newComp.nightlyUsd}
              onChange={(e) => setNewComp((p) => ({ ...p, nightlyUsd: e.target.value }))}
              className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
            />
          </label>
          <button
            type="button"
            onClick={() => void addComp()}
            className="flex items-center justify-center gap-1 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90"
          >
            <Plus size={13} /> Add comp
          </button>
        </div>
      </div>

      {/* Settings */}
      <div className="bg-card border border-border rounded-xl p-5 flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={settings.includeInPlan}
            onChange={(e) => void mutate({ settings: { includeInPlan: e.target.checked } })}
            className="accent-[hsl(var(--primary))]"
          />
          Feed the projected net into the retirement plan
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Rental years
          <input
            type="number"
            defaultValue={settings.rentalYears}
            onBlur={(e) => void mutate({ settings: { rentalYears: Number(e.target.value) } })}
            className="w-20 bg-background border border-border rounded px-2 py-1 text-sm text-foreground"
          />
        </label>
      </div>
    </div>
  )
}
