import {
  Banknote,
  HeartPulse,
  Landmark,
  MessageCircle,
  Plane,
  ScrollText,
  ShoppingBag
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import DataRightsCard from '../components/data-rights/DataRightsCard'
import DataRightsProgress from '../components/data-rights/DataRightsProgress'
import { useToast } from '../components/ui/Toast'
import { DATA_RIGHTS_SOURCES, type DataRightsDomain } from '../lib/data-rights'
import {
  type DataRightsStatus,
  type DataRightsStatusInputs,
  getDataRightsStatus,
  summarizeDataRightsProgress
} from '../lib/data-rights-status'
import { cn } from '../lib/utils'

const DOMAIN_ORDER: DataRightsDomain[] = [
  'Financial',
  'Government',
  'Health',
  'Travel',
  'Social & Communications',
  'Lifestyle & Shopping'
]
const DOMAIN_ICON: Record<DataRightsDomain, JSX.Element> = {
  Financial: <Banknote size={15} />,
  Government: <Landmark size={15} />,
  Health: <HeartPulse size={15} />,
  Travel: <Plane size={15} />,
  'Social & Communications': <MessageCircle size={15} />,
  'Lifestyle & Shopping': <ShoppingBag size={15} />
}

type StatusFilter = 'all' | DataRightsStatus
type MethodFilter = 'all' | 'live' | 'download'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'not-started', label: 'Not started' },
  { value: 'requested', label: 'Requested' },
  { value: 'imported', label: 'Imported' }
]
const METHOD_FILTERS: { value: MethodFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Connect' },
  { value: 'download', label: 'Download' }
]

const EMPTY_INPUTS: DataRightsStatusInputs = {
  importedSources: new Set(),
  connectedIntegrations: new Set(),
  requestedIds: new Set()
}

export default function DataRights(): JSX.Element {
  const { toast } = useToast()
  const [running, setRunning] = useState<string | null>(null)
  // Adapter ids the main process reports as automatable — empty unless portal
  // automation is enabled (COMPASS_ENABLE_CRED). Drives the "Automate" button's
  // visibility, so an unvalidated/disabled adapter never shows an affordance.
  const [automatable, setAutomatable] = useState<Set<string>>(new Set())
  const [inputs, setInputs] = useState<DataRightsStatusInputs>(EMPTY_INPUTS)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('all')
  const sectionRefs = useRef<Partial<Record<DataRightsDomain, HTMLElement | null>>>({})

  async function refreshStatusInputs(): Promise<void> {
    if (typeof window === 'undefined' || !window.api) return
    const [facets, integrationRows, requested] = await Promise.all([
      window.api.records.facets().catch(() => ({ sources: [], types: [] })),
      window.api.auth.getStatus().catch(() => []),
      window.api.dataRights.getRequested().catch(() => ({}))
    ])
    setInputs({
      importedSources: new Set(facets.sources),
      // Static-registry "implemented" flag is a separate concern (see
      // src/lib/integration-registry.ts) — this is the per-user connection
      // state. Plaid/SimpleFIN's multi-connection nuance (Integrations.tsx)
      // doesn't apply here yet since no Wave-1 catalog entry uses them.
      connectedIntegrations: new Set(
        integrationRows.filter((r) => r.status === 'connected').map((r) => r.service)
      ),
      requestedIds: new Set(Object.keys(requested))
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only initialization
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.cred) return
    window.api.cred
      .list()
      .then((list) => setAutomatable(new Set(list.map((a) => a.id))))
      .catch(() => {})
    refreshStatusInputs()
  }, [])

  const progress = useMemo(() => summarizeDataRightsProgress(DATA_RIGHTS_SOURCES, inputs), [inputs])

  const filteredSources = useMemo(() => {
    const q = search.trim().toLowerCase()
    return DATA_RIGHTS_SOURCES.filter((s) => {
      if (q && !`${s.name} ${s.what} ${s.domain}`.toLowerCase().includes(q)) return false
      const status = getDataRightsStatus(s, inputs)
      if (statusFilter !== 'all' && status !== statusFilter) return false
      if (methodFilter === 'live' && s.method !== 'live') return false
      if (methodFilter === 'download' && s.method === 'live') return false
      return true
    })
  }, [search, statusFilter, methodFilter, inputs])

  function jumpToDomain(domain: DataRightsDomain): void {
    sectionRefs.current[domain]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function markRequested(sourceId: string): Promise<void> {
    await window.api.dataRights.markRequested(sourceId)
    await refreshStatusInputs()
  }

  async function clearRequested(sourceId: string): Promise<void> {
    await window.api.dataRights.clearRequested(sourceId)
    await refreshStatusInputs()
  }

  async function automate(adapterId: string, name: string): Promise<void> {
    if (running) return
    setRunning(adapterId)
    toast(`Opening ${name} — log in when the window appears.`, 'info')
    try {
      const res = await window.api.cred.run(adapterId)
      if (res.ok) {
        const n = res.imported ?? 0
        toast(`Imported ${n} record${n === 1 ? '' : 's'} from ${name}.`, n > 0 ? 'success' : 'info')
        if (n > 0) await refreshStatusInputs()
      } else if (res.cancelled) {
        toast(`${name} pull cancelled.`, 'info')
      } else {
        toast(res.error || `Couldn't pull from ${name}.`, 'error')
      }
    } catch {
      toast(`Couldn't pull from ${name}.`, 'error')
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-center gap-2.5 mb-1">
        <ScrollText size={22} className="text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">Get Your Data</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6 max-w-xl">
        You have a right to most of the data companies and agencies hold about you. Here's where to
        request each one — then drop the export on your{' '}
        <span className="text-foreground">Timeline</span> to keep it forever.
      </p>

      <DataRightsProgress progress={progress} onJumpToDomain={jumpToDomain} />

      <div className="mb-6 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sources…"
          aria-label="Search data sources"
          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 sm:w-56"
        />
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                statusFilter === f.value
                  ? 'border-primary/40 bg-primary/20 text-primary'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              )}
            >
              {f.label}
            </button>
          ))}
          <span className="mx-1 self-center text-border">|</span>
          {METHOD_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setMethodFilter(f.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                methodFilter === f.value
                  ? 'border-primary/40 bg-primary/20 text-primary'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filteredSources.length === 0 && (
        <p className="mb-8 text-sm text-muted-foreground">No sources match your filters.</p>
      )}

      <div className="space-y-8">
        {DOMAIN_ORDER.map((domain) => {
          const sources = filteredSources.filter((s) => s.domain === domain)
          if (sources.length === 0) return null
          return (
            <section
              key={domain}
              ref={(el) => {
                sectionRefs.current[domain] = el
              }}
            >
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                <span className="text-primary">{DOMAIN_ICON[domain]}</span>
                {domain}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {sources.map((s) => {
                  const status = getDataRightsStatus(s, inputs)
                  return (
                    <DataRightsCard
                      key={s.id}
                      source={s}
                      status={status}
                      automatable={Boolean(s.adapterId && automatable.has(s.adapterId))}
                      automating={running === s.adapterId}
                      automateDisabled={running !== null}
                      onAutomate={() => s.adapterId && automate(s.adapterId, s.name)}
                      onMarkRequested={() => markRequested(s.id)}
                      onClearRequested={() => clearRequested(s.id)}
                    />
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      <p className="mt-8 text-xs text-muted-foreground/70">
        Everything stays on your machine — Compass never sends your exports anywhere; it just
        indexes them locally. "Automate this pull" opens the portal's real login in a sandboxed
        window — you log in (and do any 2-factor) yourself; your password is never stored.
      </p>
    </div>
  )
}
