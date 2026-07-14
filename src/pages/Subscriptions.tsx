/**
 * Subscriptions (redesign, phase 1) — Tracked / Discovered, mirroring the
 * Merchants/Places master–detail shape: Tracked is a search+list left column
 * with a full profile (SubscriptionDetail) on the right; Discovered is the
 * existing "detected in transactions" + "from your timeline" promote flows,
 * relocated here from the old flat list rather than rewritten.
 *
 * Phase 2 (a separate follow-up) adds consent-gated web enrichment — pricing
 * & plans, cancellation steps, alternatives — to the detail panel. This page
 * and SubscriptionDetail.tsx are built without it, not stubbed for it.
 */
import { AlertTriangle, CreditCard, Download, Plus, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import SubscriptionDetail, { EditForm } from '../components/SubscriptionDetail'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const EMPTY: SubscriptionInput = {
  name: '',
  cost: 0,
  cadence: 'monthly',
  category: '',
  status: 'active',
  nextRenewal: '',
  trialEndsAt: '',
  paymentAccount: '',
  cancelUrl: '',
  notes: ''
}

/** Calendar days until an ISO 'YYYY-MM-DD' date; null when unset/unparseable. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const target = new Date(`${iso}T00:00:00`).getTime()
  if (Number.isNaN(target)) return null
  return Math.ceil((target - Date.now()) / 86_400_000)
}

type Tab = 'tracked' | 'discovered'
const OVERVIEW_WINDOW_DAYS = 7

export default function Subscriptions(): JSX.Element {
  const [tab, setTab] = useState<Tab | null>(null) // null until tracked loads (pick default)
  const [tracked, setTracked] = useState<SubscriptionListItem[]>([])
  const [trackedLoaded, setTrackedLoaded] = useState(false)
  const [detected, setDetected] = useState<DetectedSubscriptions | null>(null)
  const [candidates, setCandidates] = useState<DerivedEntity[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<SubscriptionInput>(EMPTY)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const loadTracked = useCallback(async (): Promise<SubscriptionListItem[]> => {
    if (!isElectron()) {
      setTrackedLoaded(true)
      return []
    }
    try {
      const rows = await window.api.subscriptions.list()
      setTracked(rows)
      return rows
    } catch {
      toast('Could not load tracked subscriptions', 'error')
      return []
    } finally {
      setTrackedLoaded(true)
    }
  }, [toast])

  const loadDiscovered = useCallback(async (): Promise<void> => {
    if (!isElectron()) return
    const [det, cand] = await Promise.all([
      window.api.subscriptions.getDetected().catch(() => null),
      window.api.entities.list({ kind: 'subscription-candidate' }).catch(() => [])
    ])
    setDetected(det)
    setCandidates(cand)
  }, [])

  useEffect(() => {
    void loadTracked().then((rows) => {
      setTab((prev) => prev ?? (rows.length > 0 ? 'tracked' : 'discovered'))
      setSelectedId((prev) => prev ?? rows[0]?.id ?? null)
    })
    void loadDiscovered()
  }, [loadTracked, loadDiscovered])

  const activeSubs = useMemo(() => tracked.filter((s) => s.status === 'active'), [tracked])
  const activeAnnual = activeSubs.reduce((sum, s) => sum + s.annualCost, 0)
  const renewingSoonCount = activeSubs.filter((s) => {
    const d = daysUntil(s.nextRenewal)
    return d != null && d >= 0 && d <= OVERVIEW_WINDOW_DAYS
  }).length
  const trialsEndingSoonCount = activeSubs.filter((s) => {
    const d = daysUntil(s.trialEndsAt)
    return d != null && d >= 0 && d <= OVERVIEW_WINDOW_DAYS
  }).length
  const lowValueCount = activeSubs.filter((s) => {
    const rating = s.meta?.usage?.rating
    return rating === 'rarely' || rating === 'barely'
  }).length

  const shownTracked = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tracked
    return tracked.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.category ?? '').toLowerCase().includes(q)
    )
  }, [tracked, search])

  // Records-derived subscription candidates the user hasn't tracked yet. Exclude
  // any already promoted (engine flags `promotedKind==='subscription'`), any the
  // finance audit already surfaces above (same normalized merchant key), and any
  // the user already curates in the owned list (manual subs the engine can't flag,
  // matched by name) — so a service is never listed twice.
  const untrackedDetected = (detected?.active ?? []).filter((d) => !d.tracked)
  const detectedMerchants = new Set((detected?.active ?? []).map((d) => d.merchant))
  const ownedSubNames = new Set(tracked.map((s) => s.name.trim().toLowerCase()))
  const untrackedCandidates = candidates.filter(
    (c) =>
      c.promotedKind !== 'subscription' &&
      !detectedMerchants.has(c.key) &&
      !ownedSubNames.has(c.key) &&
      !ownedSubNames.has(c.name.trim().toLowerCase())
  )
  const discoveredCount = untrackedDetected.length + untrackedCandidates.length

  function startAdd(): void {
    setDraft({ ...EMPTY })
    setAdding(true)
  }

  async function saveNew(): Promise<void> {
    if (!isElectron()) return
    if (!draft.name?.trim()) {
      toast('A subscription needs a name.', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.subscriptions.create(draft)
      toast('Subscription added.', 'success')
      setAdding(false)
      const rows = await loadTracked()
      setTab('tracked')
      setSelectedId(res.id ?? rows[0]?.id ?? null)
    } finally {
      setBusy(false)
    }
  }

  function handleChanged(): void {
    void loadTracked()
  }

  function handleDeleted(): void {
    setSelectedId(null)
    void loadTracked().then((rows) => {
      setSelectedId(rows[0]?.id ?? null)
      if (rows.length === 0) setTab('discovered')
    })
  }

  async function track(d: DetectedSubscription): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      const res = await window.api.subscriptions.trackDetected({
        merchant: d.merchant,
        account: d.account,
        category: d.category,
        cadence: d.cadence,
        medianAmount: d.medianAmount
      })
      toast(`Now tracking ${d.merchant}.`, 'success')
      const rows = await loadTracked()
      void loadDiscovered()
      setTab('tracked')
      setSelectedId(res.id ?? rows[0]?.id ?? null)
    } finally {
      setBusy(false)
    }
  }

  async function trackCandidate(c: DerivedEntity): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      const res = await window.api.entities.promote({ kind: 'subscription-candidate', key: c.key })
      if (res.success) toast(`Now tracking ${c.name}.`, 'success')
      else toast(res.error ?? 'Could not track this subscription.', 'error')
      const rows = await loadTracked()
      void loadDiscovered()
      if (res.success) {
        setTab('tracked')
        setSelectedId(rows.find((r) => r.name.toLowerCase() === c.name.toLowerCase())?.id ?? null)
      }
    } finally {
      setBusy(false)
    }
  }

  async function dismissDetected(d: DetectedSubscription): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      await window.api.subscriptions.dismissDetected({ merchant: d.merchant, account: d.account })
      toast(`${d.merchant} won't be suggested again.`, 'success')
      void loadDiscovered()
    } finally {
      setBusy(false)
    }
  }

  async function dismissCandidate(c: DerivedEntity): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      await window.api.entities.exclude([{ kind: 'subscription-candidate', key: c.key }])
      toast(`${c.name} won't be suggested again. (Undo in Settings.)`, 'success')
      void loadDiscovered()
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv(): Promise<void> {
    if (!isElectron()) return
    const r = await window.api.subscriptions.exportCsv()
    if (r.canceled) return
    if (r.success) toast(`Exported ${r.count ?? 0} subscription(s).`, 'success')
    else toast(`Export failed: ${r.error}`, 'error')
  }

  const trackedCount = trackedLoaded ? tracked.length : null

  return (
    <div className="p-8 pt-14 max-w-5xl mx-auto animate-fade-in">
      <div className="flex items-start justify-between mb-5">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <CreditCard size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Subscriptions</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            One place for everything you pay for — cost, history, and whether it's worth keeping.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors"
          >
            <Download size={12} /> CSV
          </button>
          <button
            type="button"
            onClick={startAdd}
            className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      {/* Overview strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <OverviewStat
          label="Active"
          value={`${activeSubs.length}`}
          sub={`${money(activeAnnual)}/yr`}
        />
        <OverviewStat
          label="Renewing soon"
          value={`${renewingSoonCount}`}
          sub={`next ${OVERVIEW_WINDOW_DAYS} days`}
          warn={renewingSoonCount > 0}
        />
        <OverviewStat
          label="Trials ending"
          value={`${trialsEndingSoonCount}`}
          sub={`next ${OVERVIEW_WINDOW_DAYS} days`}
          warn={trialsEndingSoonCount > 0}
        />
        <OverviewStat
          label="Flagged low-value"
          value={`${lowValueCount}`}
          sub="rarely/barely used"
          warn={lowValueCount > 0}
        />
      </div>

      {adding && (
        <div className="mb-6">
          <EditForm
            draft={draft}
            setDraft={setDraft}
            onSave={saveNew}
            onCancel={() => setAdding(false)}
            busy={busy}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border mb-5">
        {(
          [
            { key: 'tracked' as Tab, label: 'Tracked', count: trackedCount },
            { key: 'discovered' as Tab, label: 'Discovered', count: discoveredCount }
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3.5 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {t.count != null && (
              <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'discovered' && (
        <div className="space-y-8">
          {untrackedDetected.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Detected in your transactions ({untrackedDetected.length})
              </h2>
              <p className="text-xs text-muted-foreground/70 mb-3">
                Recurring charges Compass spotted but you're not tracking yet.
              </p>
              <div className="space-y-2">
                {untrackedDetected.map((d) => (
                  <div
                    key={`${d.merchant}::${d.account}`}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground capitalize flex items-center gap-2">
                        {d.merchant}
                        {d.priceHike && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500">
                            <AlertTriangle size={9} /> +{d.priceHikePct.toFixed(0)}%
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {d.cadence} · {money(d.medianAmount)} · {money(d.annualCost)}/yr ·{' '}
                        {d.account}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void track(d)}
                      disabled={busy}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Plus size={11} /> Track
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismissDetected(d)}
                      disabled={busy}
                      title="Not a subscription — don't suggest again"
                      aria-label={`Not a subscription: ${d.merchant}`}
                      className="flex items-center gap-1 text-xs px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {untrackedCandidates.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                From your timeline ({untrackedCandidates.length})
              </h2>
              <p className="text-xs text-muted-foreground/70 mb-3">
                Recurring services Compass found across your imported data (PayPal, Amazon,
                Netflix…) — not just your bank transactions.
              </p>
              <div className="space-y-2">
                {untrackedCandidates.map((c) => (
                  <div
                    key={c.key}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground capitalize">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.attrs.cadence ?? 'recurring'}
                        {c.attrs.medianAmount != null && ` · ${money(c.attrs.medianAmount)}`}
                        {c.attrs.annualCost != null && ` · ${money(c.attrs.annualCost)}/yr`}
                        {c.sources.length > 0 && ` · ${c.sources.join(', ')}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void trackCandidate(c)}
                      disabled={busy}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Plus size={11} /> Track
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismissCandidate(c)}
                      disabled={busy}
                      title="Not a subscription — don't suggest again"
                      aria-label={`Not a subscription: ${c.name}`}
                      className="flex items-center gap-1 text-xs px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {discoveredCount === 0 && (
            <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
              <Sparkles size={20} className="mx-auto mb-2 text-muted-foreground" />
              Nothing new detected. Compass will surface recurring charges here as they show up in
              your transactions or imported data.
            </div>
          )}
        </div>
      )}

      {tab === 'tracked' &&
        (trackedLoaded && tracked.length === 0 && !adding ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
              <CreditCard size={26} />
            </div>
            <p className="text-sm text-muted-foreground max-w-sm">
              Track every recurring cost in one place — even the ones Compass can't see in your
              transactions. Add one, or head to{' '}
              <button
                type="button"
                onClick={() => setTab('discovered')}
                className="text-primary hover:underline"
              >
                Discovered
              </button>{' '}
              to track what it already found.
            </p>
          </div>
        ) : (
          <div className="flex gap-6 items-start">
            {/* Tracked list */}
            <div className="w-64 shrink-0 space-y-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a tracked subscription…"
                aria-label="Search tracked subscriptions"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
              <ul className="space-y-1">
                {shownTracked.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className={cn(
                        'w-full text-left rounded-lg px-3 py-2 transition-colors border',
                        s.id === selectedId
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-transparent hover:bg-secondary/60'
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {s.name}
                        </span>
                        <span className="text-xs text-foreground shrink-0 tabular-nums">
                          {money(s.annualCost)}/yr
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span className="capitalize">{s.status}</span>
                        {s.priceHike && (
                          <span className="text-amber-500 flex items-center gap-0.5">
                            <AlertTriangle size={9} /> hike
                          </span>
                        )}
                        {s.zombie && <span className="text-amber-500">zombie</span>}
                        {s.isDuplicate && <span className="text-amber-500">duplicate</span>}
                        {s.unused && <span className="text-amber-500">unused</span>}
                      </div>
                    </button>
                  </li>
                ))}
                {shownTracked.length === 0 && trackedLoaded && (
                  <li className="text-xs text-muted-foreground px-3 py-4">
                    {search ? 'No matches.' : 'Nothing tracked yet.'}
                  </li>
                )}
              </ul>
            </div>

            {/* Detail */}
            <div className="flex-1 min-w-0">
              {selectedId ? (
                <SubscriptionDetail
                  subscriptionId={selectedId}
                  onChanged={handleChanged}
                  onDeleted={handleDeleted}
                />
              ) : (
                <p className="text-sm text-muted-foreground pt-8 text-center">
                  Select a subscription to see everything you know about it.
                </p>
              )}
            </div>
          </div>
        ))}
    </div>
  )
}

function OverviewStat({
  label,
  value,
  sub,
  warn
}: {
  label: string
  value: string
  sub: string
  warn?: boolean
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold mt-0.5 tabular-nums',
          warn ? 'text-amber-500' : 'text-foreground'
        )}
      >
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
    </div>
  )
}
