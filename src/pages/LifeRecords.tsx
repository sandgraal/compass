/**
 * Life Records — the plaintext successor of the vault's document categories
 * (financial / identity / medical / legal / foreign-accounts). Metadata lives
 * in `life_records` and is searchable, timeline-projected, and AI/MCP-readable;
 * each record's SECRET field values (account/routing numbers, SSN/passport
 * numbers, member IDs) stay encrypted in the vault, fetched one record at a
 * time via `life:get-secrets` and rendered with the reveal/copy affordances.
 */
import {
  Banknote,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Globe,
  HeartPulse,
  IdCard,
  Link2,
  Lock,
  Pencil,
  Plus,
  Scale,
  ShieldCheck,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  financial: <Banknote size={16} />,
  identity: <IdCard size={16} />,
  medical: <HeartPulse size={16} />,
  legal: <Scale size={16} />,
  'foreign-accounts': <Globe size={16} />
}

// Non-Electron (dev preview) fallback — mirrors LIFE_CATEGORIES in
// electron/lib/life-records.ts; the real app always gets them over IPC.
const FALLBACK_CATEGORIES: LifeCategory[] = [
  {
    id: 'financial',
    label: 'Financial',
    icon: 'banknote',
    description: 'Bank accounts, credit cards, investments',
    fields: [
      { key: 'institution', label: 'Institution' },
      { key: 'accountType', label: 'Account Type' },
      { key: 'lastFour', label: 'Last 4 Digits' },
      { key: 'accountNumber', label: 'Account Number', secret: true },
      { key: 'routingNumber', label: 'Routing Number', secret: true }
    ]
  },
  {
    id: 'identity',
    label: 'Identity',
    icon: 'id-card',
    description: "SSN, passport, driver's license",
    fields: [
      { key: 'documentType', label: 'Document Type' },
      { key: 'number', label: 'Number', secret: true },
      { key: 'issueDate', label: 'Issue Date' },
      { key: 'expiryDate', label: 'Expiry Date' }
    ]
  },
  {
    id: 'medical',
    label: 'Medical',
    icon: 'heart-pulse',
    description: 'Insurance, prescriptions, providers',
    fields: [
      { key: 'type', label: 'Type (insurance/rx/provider)' },
      { key: 'provider', label: 'Provider / Insurer' },
      { key: 'memberId', label: 'Member ID', secret: true },
      { key: 'groupNumber', label: 'Group Number', secret: true }
    ]
  },
  {
    id: 'legal',
    label: 'Legal',
    icon: 'scale',
    description: 'Contracts, wills, property documents',
    fields: [
      { key: 'documentType', label: 'Document Type' },
      { key: 'parties', label: 'Parties Involved' },
      { key: 'date', label: 'Date' },
      { key: 'location', label: 'Stored Location' }
    ]
  },
  {
    id: 'foreign-accounts',
    label: 'Foreign Accounts',
    icon: 'globe',
    description: 'FBAR/FATCA — foreign bank/securities accounts',
    fields: [
      { key: 'institution', label: 'Institution' },
      { key: 'country', label: 'Country' },
      { key: 'accountType', label: 'Account Type (bank / securities)' },
      { key: 'maxValueUsd', label: 'Max Value During Year (USD)' },
      { key: 'accountNumber', label: 'Account Number', secret: true }
    ]
  }
]

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

// Fixed set of valid category ids (mirrors LIFE_CATEGORY_IDS in
// electron/lib/life-records.ts) — used to validate untrusted sessionStorage
// input before it becomes `selectedCategory` state.
const KNOWN_CATEGORY_IDS = new Set(Object.keys(CATEGORY_ICONS))

interface Draft {
  fields: Record<string, string>
  secrets: Record<string, string>
  notes: string
}
const EMPTY_DRAFT: Draft = { fields: {}, secrets: {}, notes: '' }

export default function LifeRecords(): JSX.Element {
  const [categories, setCategories] = useState<LifeCategory[]>([])
  const [selectedCategory, setSelectedCategory] = useState('financial')
  const [records, setRecords] = useState<LifeRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  // Per-record decrypted secrets, fetched on demand. Cleared on category switch.
  const [secretsById, setSecretsById] = useState<Record<number, Record<string, string>>>({})
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copiedField, setCopiedField] = useState<string | null>(null)
  // Inline link picker: which record is being linked + the draft selection.
  // Targets (contacts/accounts) load lazily on the first "Link" click.
  const [linkingId, setLinkingId] = useState<number | null>(null)
  const [linkKind, setLinkKind] = useState<'contact' | 'account'>('contact')
  const [linkTargetId, setLinkTargetId] = useState<number | ''>('')
  const [linkTargets, setLinkTargets] = useState<{
    contacts: Array<{ id: number; name: string }>
    accounts: Array<{ id: number; name: string }>
  } | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()

  useEffect(() => {
    if (isElectron()) {
      window.api.life
        .categories()
        .then(setCategories)
        .catch(() => setCategories(FALLBACK_CATEGORIES))
    } else {
      setCategories(FALLBACK_CATEGORIES)
    }
    // ⌘K deep-link: a `life` search hit stashes the category before navigating.
    // Validate against the known ids — untrusted storage must never put the
    // page into a category create/update can't handle.
    const pending = sessionStorage.getItem('compass:open-life-category')
    if (pending) {
      sessionStorage.removeItem('compass:open-life-category')
      if (KNOWN_CATEGORY_IDS.has(pending)) setSelectedCategory(pending)
    }
  }, [])

  useEffect(() => {
    setSecretsById({})
    setRevealed(new Set())
    setAdding(false)
    setEditingId(null)
    void load(selectedCategory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory])

  async function load(category = selectedCategory): Promise<void> {
    setLoading(true)
    try {
      if (!isElectron()) {
        setRecords([])
        return
      }
      setRecords(await window.api.life.list({ category }))
    } catch (err) {
      console.error('[life-records] list failed', err)
      toast('Failed to load life records.', 'error')
    } finally {
      setLoading(false)
    }
  }

  const selectedCat = categories.find((c) => c.id === selectedCategory)
  const template = selectedCat?.fields ?? []

  function startAdd(): void {
    setDraft(EMPTY_DRAFT)
    setEditingId(null)
    setAdding(true)
  }

  async function startEdit(record: LifeRecord): Promise<void> {
    const secrets = record.hasSecrets ? await fetchSecrets(record.id) : {}
    setDraft({ fields: { ...record.fields }, secrets: { ...secrets }, notes: record.notes ?? '' })
    setAdding(false)
    setEditingId(record.id)
  }

  async function fetchSecrets(id: number): Promise<Record<string, string>> {
    if (secretsById[id]) return secretsById[id]
    try {
      const secrets = await window.api.life.getSecrets(id)
      setSecretsById((prev) => ({ ...prev, [id]: secrets }))
      return secrets
    } catch (err) {
      console.error('[life-records] get-secrets failed', err)
      toast('Could not decrypt the secret fields.', 'error')
      return {}
    }
  }

  async function save(): Promise<void> {
    if (!isElectron() || busy) return
    setBusy(true)
    try {
      const payload: LifeRecordInput = {
        category: selectedCategory,
        fields: draft.fields,
        notes: draft.notes.trim() || null,
        secrets: draft.secrets
      }
      if (editingId == null) {
        await window.api.life.create(payload)
        toast('Record added. Secret fields stay encrypted in the vault.', 'success')
      } else {
        await window.api.life.update(editingId, payload)
        toast('Record saved.', 'success')
        setSecretsById((prev) => {
          const next = { ...prev }
          delete next[editingId]
          return next
        })
      }
      setAdding(false)
      setEditingId(null)
      setDraft(EMPTY_DRAFT)
      await load()
    } catch (err) {
      console.error('[life-records] save failed', err)
      toast('Failed to save the record.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function startLinking(record: LifeRecord): Promise<void> {
    // Financial-ish categories most often link the account; the rest a person.
    setLinkKind(
      record.category === 'financial' || record.category === 'foreign-accounts'
        ? 'account'
        : 'contact'
    )
    setLinkTargetId('')
    setLinkingId(record.id)
    if (linkTargets || !isElectron()) return
    try {
      const [cs, accts] = await Promise.all([
        window.api.contacts.list(),
        window.api.finance.getAccounts()
      ])
      setLinkTargets({
        contacts: cs.map((c) => ({ id: c.id, name: c.displayName })),
        accounts: accts.map((a) => ({ id: a.id, name: a.name }))
      })
    } catch (err) {
      console.error('[life-records] link targets failed', err)
      toast('Could not load link targets.', 'error')
      setLinkingId(null)
    }
  }

  async function addLink(recordId: number): Promise<void> {
    if (!isElectron() || linkTargetId === '') return
    try {
      await window.api.life.setLink({
        lifeRecordId: recordId,
        targetKind: linkKind,
        targetId: linkTargetId
      })
      setLinkingId(null)
      await load()
    } catch (err) {
      console.error('[life-records] set-link failed', err)
      toast('Could not add the link.', 'error')
    }
  }

  async function removeLink(linkId: number): Promise<void> {
    if (!isElectron()) return
    try {
      await window.api.life.removeLink(linkId)
      await load()
    } catch (err) {
      console.error('[life-records] remove-link failed', err)
      toast('Could not remove the link.', 'error')
    }
  }

  async function remove(record: LifeRecord): Promise<void> {
    const ok = await confirm({
      title: 'Delete record?',
      description: `“${record.title}” and its sealed secret fields will be permanently removed.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok || !isElectron()) return
    await window.api.life.delete(record.id)
    setRecords((prev) => prev.filter((r) => r.id !== record.id))
  }

  async function exportCsv(): Promise<void> {
    if (!isElectron()) return
    setExporting(true)
    try {
      const r = await window.api.life.exportCsv()
      if (r.canceled) return
      if (r.success)
        toast(`Exported ${r.count ?? 0} record(s). Secret fields are not included.`, 'success')
      else toast(`Export failed: ${r.error}`, 'error')
    } finally {
      setExporting(false)
    }
  }

  async function toggleReveal(recordId: number, fieldKey: string): Promise<void> {
    const key = `${recordId}:${fieldKey}`
    if (!revealed.has(key)) await fetchSecrets(recordId)
    setRevealed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  async function copySecret(recordId: number, fieldKey: string): Promise<void> {
    const secrets = await fetchSecrets(recordId)
    const value = secrets[fieldKey]
    if (!value) return
    navigator.clipboard.writeText(value)
    setCopiedField(`${recordId}:${fieldKey}`)
    setTimeout(() => setCopiedField(null), 30000)
  }

  const form = (
    <div className="bg-card border border-primary/30 rounded-xl p-5 mb-6">
      <h3 className="text-sm font-semibold mb-4">
        {editingId == null ? `New ${selectedCat?.label} record` : 'Edit record'}
      </h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        {template.map((field) => (
          <div key={field.key}>
            <label
              htmlFor={`life-field-${field.key}`}
              className="text-xs text-muted-foreground mb-1 flex items-center gap-1"
            >
              {field.label}
              {field.secret && <Lock size={9} className="text-primary" />}
            </label>
            <input
              id={`life-field-${field.key}`}
              type={field.secret ? 'password' : 'text'}
              value={(field.secret ? draft.secrets[field.key] : draft.fields[field.key]) || ''}
              onChange={(e) =>
                setDraft((prev) =>
                  field.secret
                    ? { ...prev, secrets: { ...prev.secrets, [field.key]: e.target.value } }
                    : { ...prev, fields: { ...prev.fields, [field.key]: e.target.value } }
                )
              }
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        ))}
      </div>
      <div className="mb-4">
        <label htmlFor="life-notes" className="text-xs text-muted-foreground mb-1 block">
          Notes
        </label>
        <textarea
          id="life-notes"
          value={draft.notes}
          onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))}
          rows={2}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <p className="mr-auto text-[11px] text-muted-foreground/70 flex items-center gap-1">
          <Lock size={10} className="text-primary" />
          Fields marked with a lock are encrypted in the vault, never in plain storage.
        </p>
        <button
          type="button"
          onClick={() => {
            setAdding(false)
            setEditingId(null)
          }}
          className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex h-full pt-10">
      {/* Category sidebar */}
      <div className="w-56 shrink-0 border-r border-border bg-card/40 flex flex-col pt-4">
        <div className="px-4 pb-3 flex items-center gap-2">
          <IdCard size={14} className="text-primary" />
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Life Records
          </span>
        </div>

        <div className="flex-1 space-y-0.5 px-2">
          {categories.map((cat) => (
            <button
              type="button"
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left',
                selectedCategory === cat.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
              )}
            >
              {CATEGORY_ICONS[cat.id]}
              {cat.label}
              <ChevronRight
                size={12}
                className={cn(
                  'ml-auto transition-transform',
                  selectedCategory === cat.id && 'rotate-90'
                )}
              />
            </button>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-border space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck size={11} className="text-emerald-400" />
            Secrets sealed in the vault
          </div>
          <p className="text-xs text-muted-foreground/50">
            Everything else is searchable and on your timeline.
          </p>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="w-full flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
          >
            <Download size={10} />
            {exporting ? 'Exporting…' : 'Export CSV (no secrets)'}
          </button>
        </div>
      </div>

      {/* Records panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              {CATEGORY_ICONS[selectedCategory]}
              {selectedCat?.label}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{selectedCat?.description}</p>
          </div>
          <button
            type="button"
            onClick={startAdd}
            className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
          >
            <Plus size={14} /> Add record
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {adding && form}

          {loading ? (
            <div className="space-y-3">
              {[1, 2].map((n) => (
                <div key={n} className="h-24 bg-secondary/30 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : records.length === 0 && !adding ? (
            <div className="flex flex-col items-center py-16 gap-3">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
                {CATEGORY_ICONS[selectedCategory]}
              </div>
              <p className="text-sm text-muted-foreground">
                No {selectedCat?.label.toLowerCase()} records yet
              </p>
              <button
                type="button"
                onClick={startAdd}
                className="text-xs text-primary hover:underline"
              >
                Add your first record
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {records.map((record) =>
                editingId === record.id ? (
                  <div key={record.id}>{form}</div>
                ) : (
                  <div key={record.id} className="bg-card border border-border rounded-xl p-5">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                          {record.title}
                          {record.hasSecrets && (
                            <span
                              title="This record has secret fields sealed in the encrypted vault"
                              className="flex items-center gap-1 text-[10px] font-normal text-primary bg-primary/10 rounded-full px-1.5 py-0.5"
                            >
                              <Lock size={9} /> secrets
                            </span>
                          )}
                        </h3>
                        {record.source !== 'manual' && (
                          <p className="text-[11px] text-muted-foreground/70 mt-0.5 capitalize">
                            {record.source.replace('-', ' ')}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            navigate(`/timeline?q=${encodeURIComponent(record.title)}`)
                          }
                          title="See this record on the timeline"
                          className="text-[11px] px-2 py-1 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Timeline
                        </button>
                        <button
                          type="button"
                          onClick={() => void startEdit(record)}
                          aria-label={`Edit ${record.title}`}
                          className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(record)}
                          aria-label={`Delete ${record.title}`}
                          className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                      {template
                        .filter((f) => !f.secret && record.fields[f.key])
                        .map((f) => (
                          <div key={f.key} className="min-w-0">
                            <p className="text-[11px] text-muted-foreground">{f.label}</p>
                            <p className="text-sm text-foreground truncate">
                              {record.fields[f.key]}
                            </p>
                          </div>
                        ))}
                      {record.hasSecrets &&
                        template
                          .filter((f) => f.secret)
                          .map((f) => {
                            const key = `${record.id}:${f.key}`
                            const value = secretsById[record.id]?.[f.key]
                            const isRevealed = revealed.has(key)
                            return (
                              <div key={f.key} className="min-w-0">
                                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                                  {f.label} <Lock size={8} className="text-primary" />
                                </p>
                                <div className="flex items-center gap-1.5">
                                  <p className="text-sm text-foreground font-mono truncate">
                                    {isRevealed ? value || '—' : '••••••••'}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => void toggleReveal(record.id, f.key)}
                                    aria-label={
                                      isRevealed ? `Hide ${f.label}` : `Reveal ${f.label}`
                                    }
                                    className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void copySecret(record.id, f.key)}
                                    aria-label={`Copy ${f.label}`}
                                    className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    {copiedField === key ? (
                                      <span className="text-[10px] text-primary">✓</span>
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                    </div>

                    {record.notes && (
                      <p className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap">
                        {record.notes}
                      </p>
                    )}

                    {/* Links to the contact / account this record documents */}
                    <div className="mt-3 pt-2.5 border-t border-border flex items-center gap-1.5 flex-wrap">
                      {record.links.map((l) => (
                        <span
                          key={l.id}
                          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary text-foreground"
                        >
                          {l.targetKind === 'contact' ? (
                            <UserRound size={10} className="text-primary" />
                          ) : (
                            <Banknote size={10} className="text-primary" />
                          )}
                          {l.label}
                          <button
                            type="button"
                            onClick={() => void removeLink(l.id)}
                            aria-label={`Unlink ${l.label}`}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                      {linkingId === record.id ? (
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <select
                            value={linkKind}
                            onChange={(e) => {
                              setLinkKind(e.target.value as 'contact' | 'account')
                              setLinkTargetId('')
                            }}
                            aria-label="Link kind"
                            className="text-[11px] bg-secondary border border-border rounded px-1.5 py-0.5 text-foreground"
                          >
                            <option value="contact">Contact</option>
                            <option value="account">Account</option>
                          </select>
                          <select
                            value={linkTargetId}
                            onChange={(e) =>
                              setLinkTargetId(e.target.value === '' ? '' : Number(e.target.value))
                            }
                            aria-label="Link target"
                            className="max-w-44 text-[11px] bg-secondary border border-border rounded px-1.5 py-0.5 text-foreground"
                          >
                            <option value="">{linkTargets ? 'Pick…' : 'Loading…'}</option>
                            {(linkKind === 'contact'
                              ? (linkTargets?.contacts ?? [])
                              : (linkTargets?.accounts ?? [])
                            ).map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => void addLink(record.id)}
                            disabled={linkTargetId === ''}
                            className="text-[11px] text-primary hover:underline disabled:opacity-50"
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            onClick={() => setLinkingId(null)}
                            className="text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void startLinking(record)}
                          className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <Link2 size={10} /> Link
                        </button>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
