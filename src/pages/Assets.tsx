import {
  Boxes,
  Car,
  Download,
  Home,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Trophy,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const TYPES = ['insurance', 'vehicle', 'property', 'membership', 'warranty', 'pet', 'other']
const STATUSES = ['active', 'expired', 'sold', 'cancelled']

const TYPE_LABEL: Record<string, string> = {
  insurance: 'Insurance',
  vehicle: 'Vehicles',
  property: 'Property',
  membership: 'Memberships',
  warranty: 'Warranties',
  pet: 'Pets',
  other: 'Other'
}
const TYPE_ICON: Record<string, JSX.Element> = {
  insurance: <ShieldCheck size={14} />,
  vehicle: <Car size={14} />,
  property: <Home size={14} />,
  membership: <Trophy size={14} />,
  warranty: <ShieldCheck size={14} />,
  pet: <Boxes size={14} />,
  other: <Boxes size={14} />
}

const EMPTY: AssetInput = {
  type: 'property',
  name: '',
  value: null,
  provider: '',
  reference: '',
  renewalDate: '',
  status: 'active',
  notes: ''
}

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api
const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** Days until an ISO date; null if absent/unparseable. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

export default function Assets(): JSX.Element {
  const [items, setItems] = useState<AssetRecord[]>([])
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<AssetInput>(EMPTY)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    void load()
  }, [])

  async function load(): Promise<void> {
    if (!isElectron()) return
    setItems(await window.api.assets.list())
  }

  const totalValue = items
    .filter((a) => a.status === 'active')
    .reduce((sum, a) => sum + (a.value ?? 0), 0)

  // Preserve TYPES order for the grouped render.
  const grouped = TYPES.map((type) => ({
    type,
    rows: items.filter((a) => a.type === type)
  })).filter((g) => g.rows.length > 0)

  function startAdd(): void {
    setDraft({ ...EMPTY })
    setEditing('new')
  }
  function startEdit(a: AssetRecord): void {
    setDraft({
      type: a.type,
      name: a.name,
      value: a.value,
      provider: a.provider ?? '',
      reference: a.reference ?? '',
      renewalDate: a.renewalDate ?? '',
      status: a.status,
      notes: a.notes ?? ''
    })
    setEditing(a.id)
  }

  async function save(): Promise<void> {
    if (!isElectron()) return
    if (!draft.name?.trim()) {
      toast('This asset needs a name.', 'error')
      return
    }
    setBusy(true)
    try {
      if (editing === 'new') await window.api.assets.create(draft)
      else if (typeof editing === 'number') await window.api.assets.update(editing, draft)
      toast('Saved.', 'success')
      setEditing(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function remove(a: AssetRecord): Promise<void> {
    const ok = await confirm({
      title: 'Delete asset?',
      description: `${a.name} will be removed.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok || !isElectron()) return
    await window.api.assets.delete(a.id)
    await load()
  }

  async function exportCsv(): Promise<void> {
    if (!isElectron()) return
    const r = await window.api.assets.exportCsv()
    if (r.canceled) return
    if (r.success) toast(`Exported ${r.count ?? 0} asset(s).`, 'success')
    else toast(`Export failed: ${r.error}`, 'error')
  }

  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <Home size={22} className="text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Household &amp; Assets</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{money(totalValue)}</span> tracked value
            across {items.length} item{items.length === 1 ? '' : 's'}
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

      {editing !== null && (
        <AssetForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => setEditing(null)}
          busy={busy}
        />
      )}

      {items.length === 0 && editing === null ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
            <Home size={26} />
          </div>
          <p className="text-sm text-muted-foreground max-w-sm">
            Everything you own and the policies around it — houses and their value, vehicles,
            insurance, memberships, warranties, pets. Add your first asset to start the inventory.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => {
            const subtotal = g.rows.reduce((s, a) => s + (a.value ?? 0), 0)
            return (
              <div key={g.type}>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    {TYPE_ICON[g.type]} {TYPE_LABEL[g.type]} ({g.rows.length})
                  </h2>
                  {subtotal > 0 && (
                    <span className="text-xs text-muted-foreground">{money(subtotal)}</span>
                  )}
                </div>
                <div className="space-y-2">
                  {g.rows.map((a) => (
                    <AssetCard
                      key={a.id}
                      asset={a}
                      onEdit={() => startEdit(a)}
                      onDelete={() => remove(a)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-400',
  expired: 'bg-amber-500/15 text-amber-500',
  sold: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground'
}

function AssetCard({
  asset,
  onEdit,
  onDelete
}: {
  asset: AssetRecord
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  const days = daysUntil(asset.renewalDate)
  const renewSoon = days != null && days >= 0 && days <= 30
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 group">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground flex items-center gap-2">
          {asset.name}
          {asset.status !== 'active' && (
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full capitalize',
                STATUS_STYLE[asset.status] ?? 'bg-muted text-muted-foreground'
              )}
            >
              {asset.status}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {[asset.value != null ? money(asset.value) : null, asset.provider, asset.reference]
            .filter(Boolean)
            .join(' · ')}
          {asset.renewalDate && (
            <span className={cn(renewSoon && 'text-amber-500')}>
              {' · '}
              {renewSoon ? `renews in ${days}d` : `renews ${asset.renewalDate}`}
            </span>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${asset.name}`}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${asset.name}`}
        className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function AssetForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy
}: {
  draft: AssetInput
  setDraft: (d: AssetInput) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
}): JSX.Element {
  const input =
    'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'
  return (
    <div className="bg-card border border-primary/30 rounded-xl p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Asset</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close form"
          className="text-muted-foreground hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select
            className={input}
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value })}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input
            className={input}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Value">
          <input
            className={input}
            type="number"
            step="1"
            value={draft.value ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, value: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Status">
          <select
            className={input}
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Provider">
          <input
            className={input}
            placeholder="insurer / dealer / club"
            value={draft.provider ?? ''}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
          />
        </Field>
        <Field label="Reference">
          <input
            className={input}
            placeholder="policy # / VIN / member #"
            value={draft.reference ?? ''}
            onChange={(e) => setDraft({ ...draft, reference: e.target.value })}
          />
        </Field>
        <Field label="Renewal / expiry">
          <input
            className={input}
            placeholder="YYYY-MM-DD"
            value={draft.renewalDate ?? ''}
            onChange={(e) => setDraft({ ...draft, renewalDate: e.target.value })}
          />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Notes">
          <textarea
            className={input}
            rows={2}
            value={draft.notes ?? ''}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground/70 mt-3">
        Tip: keep sensitive numbers (full account / policy IDs) in the Vault — use Reference for a
        partial or lookup hint.
      </p>
      <div className="flex gap-2 justify-end mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and wrapped by this label — association is correct, biome just can't see through {children}
    <label className="block">
      <span className="text-xs text-muted-foreground mb-1 block">{label}</span>
      {children}
    </label>
  )
}
