import { useState, useEffect, useRef } from 'react'
import { ShieldCheck, Plus, Eye, EyeOff, Copy, Trash2, Lock, Banknote, IdCard, Key, HeartPulse, Scale, ChevronRight, Upload } from 'lucide-react'
import { cn } from '../lib/utils'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  financial: <Banknote size={16} />,
  identity: <IdCard size={16} />,
  credentials: <Key size={16} />,
  medical: <HeartPulse size={16} />,
  legal: <Scale size={16} />
}

const FIELD_TEMPLATES: Record<string, Array<{ key: string; label: string; sensitive?: boolean }>> = {
  financial: [
    { key: 'institution', label: 'Institution' },
    { key: 'accountType', label: 'Account Type' },
    { key: 'accountNumber', label: 'Account Number', sensitive: true },
    { key: 'routingNumber', label: 'Routing Number', sensitive: true },
    { key: 'notes', label: 'Notes' }
  ],
  identity: [
    { key: 'documentType', label: 'Document Type' },
    { key: 'number', label: 'Number', sensitive: true },
    { key: 'issueDate', label: 'Issue Date' },
    { key: 'expiryDate', label: 'Expiry Date' },
    { key: 'notes', label: 'Notes' }
  ],
  credentials: [
    { key: 'service', label: 'Service / App' },
    { key: 'username', label: 'Username / Email' },
    { key: 'password', label: 'Password', sensitive: true },
    { key: 'apiKey', label: 'API Key', sensitive: true },
    { key: 'notes', label: 'Notes' }
  ],
  medical: [
    { key: 'type', label: 'Type (insurance/rx/provider)' },
    { key: 'provider', label: 'Provider / Insurer' },
    { key: 'memberId', label: 'Member ID', sensitive: true },
    { key: 'groupNumber', label: 'Group Number', sensitive: true },
    { key: 'notes', label: 'Notes' }
  ],
  legal: [
    { key: 'documentType', label: 'Document Type' },
    { key: 'parties', label: 'Parties Involved' },
    { key: 'date', label: 'Date' },
    { key: 'location', label: 'Stored Location' },
    { key: 'notes', label: 'Notes' }
  ]
}

export default function Vault(): JSX.Element {
  const [categories, setCategories] = useState<VaultCategory[]>([])
  const [selectedCategory, setSelectedCategory] = useState('financial')
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [newEntry, setNewEntry] = useState<Record<string, string>>({})
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(message: string, type: 'success' | 'error') {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ message, type })
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  // Enable content protection when Vault is mounted; disable on unmount
  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.vault.setContentProtection(true)
      return () => { window.api.vault.setContentProtection(false) }
    }
  }, [])

  // Clear toast timer on unmount
  useEffect(() => {
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }
  }, [])

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.vault.getCategories().then(setCategories)
    } else {
      setCategories([
        { id: 'financial', label: 'Financial', icon: 'banknote', description: 'Bank accounts, credit cards' },
        { id: 'identity', label: 'Identity', icon: 'id-card', description: 'SSN, passport, ID' },
        { id: 'credentials', label: 'Credentials', icon: 'key', description: 'Passwords, API keys' },
        { id: 'medical', label: 'Medical', icon: 'heart-pulse', description: 'Insurance, prescriptions' },
        { id: 'legal', label: 'Legal', icon: 'scale', description: 'Contracts, wills' }
      ])
    }
  }, [])

  useEffect(() => {
    loadEntries()
  }, [selectedCategory])

  async function loadEntries() {
    setLoading(true)
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const e = await window.api.vault.getEntries(selectedCategory)
      setEntries(e)
    } else {
      setEntries([])
    }
    setLoading(false)
  }

  async function addEntry() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const created = await window.api.vault.addEntry(selectedCategory, newEntry)
      setEntries(prev => [...prev, created])
    } else {
      setEntries(prev => [...prev, { id: String(Date.now()), ...newEntry, createdAt: Date.now(), updatedAt: Date.now() }])
    }
    setNewEntry({})
    setAdding(false)
  }

  async function import1Password() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    setImporting(true)
    try {
      const r = await window.api.vault.import1Password()
      if (r.canceled) return
      if (r.success) {
        showToast(`Imported ${r.imported} item${r.imported === 1 ? '' : 's'} into your vault.`, 'success')
        loadEntries()
      } else {
        showToast('Import failed: ' + r.error, 'error')
      }
    } finally {
      setImporting(false)
    }
  }

  async function deleteEntry(id: string) {
    if (!confirm('Delete this entry? This cannot be undone.')) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      await window.api.vault.deleteEntry(selectedCategory, id)
    }
    setEntries(prev => prev.filter(e => e.id !== id))
  }

  function copyToClipboard(value: string, fieldKey: string) {
    navigator.clipboard.writeText(value)
    setCopiedField(fieldKey)
    setTimeout(() => setCopiedField(null), 30000) // Clear after 30s
  }

  function toggleReveal(fieldKey: string) {
    setRevealedFields(prev => {
      const next = new Set(prev)
      next.has(fieldKey) ? next.delete(fieldKey) : next.add(fieldKey)
      return next
    })
  }

  const fields = FIELD_TEMPLATES[selectedCategory] || []
  const selectedCat = categories.find(c => c.id === selectedCategory)

  return (
    <div className="flex h-full pt-10">
      {/* Category sidebar */}
      <div className="w-56 shrink-0 border-r border-border bg-card/40 flex flex-col pt-4">
        <div className="px-4 pb-3 flex items-center gap-2">
          <Lock size={14} className="text-primary" />
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">Vault</span>
        </div>

        <div className="flex-1 space-y-0.5 px-2">
          {categories.map((cat) => (
            <button
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
              <ChevronRight size={12} className={cn('ml-auto transition-transform', selectedCategory === cat.id && 'rotate-90')} />
            </button>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-border space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck size={11} className="text-emerald-400" />
            AES-256 encrypted
          </div>
          <p className="text-xs text-muted-foreground/50">Keys in OS Keychain</p>
          <button
            onClick={import1Password}
            disabled={importing}
            className="w-full flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
          >
            <Upload size={10} />
            {importing ? 'Importing…' : 'Import 1Password CSV'}
          </button>
        </div>
      </div>

      {/* Entries panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              {CATEGORY_ICONS[selectedCategory]}
              {selectedCat?.label}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{selectedCat?.description}</p>
          </div>
          <button
            onClick={() => { setAdding(true); setNewEntry({}) }}
            className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
          >
            <Plus size={14} /> Add entry
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* Add form */}
          {adding && (
            <div className="bg-card border border-primary/30 rounded-xl p-5 mb-6">
              <h3 className="text-sm font-semibold mb-4">New {selectedCat?.label} Entry</h3>
              <div className="grid grid-cols-2 gap-4 mb-4">
                {fields.map(field => (
                  <div key={field.key}>
                    <label className="text-xs text-muted-foreground mb-1 block">{field.label}</label>
                    <input
                      type={field.sensitive ? 'password' : 'text'}
                      value={newEntry[field.key] || ''}
                      onChange={(e) => setNewEntry(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
                <button onClick={addEntry} className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
                  Save encrypted
                </button>
              </div>
            </div>
          )}

          {/* Entries */}
          {loading ? (
            <div className="space-y-3">
              {[1, 2].map(n => <div key={n} className="h-24 bg-secondary/30 rounded-xl animate-pulse" />)}
            </div>
          ) : entries.length === 0 && !adding ? (
            <div className="flex flex-col items-center py-16 gap-3">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
                {CATEGORY_ICONS[selectedCategory]}
              </div>
              <p className="text-sm text-muted-foreground">No {selectedCat?.label.toLowerCase()} entries yet</p>
              <button onClick={() => setAdding(true)} className="text-xs text-primary hover:underline">Add your first entry</button>
            </div>
          ) : (
            <div className="space-y-4">
              {entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  fields={fields}
                  revealedFields={revealedFields}
                  copiedField={copiedField}
                  onToggleReveal={toggleReveal}
                  onCopy={copyToClipboard}
                  onDelete={() => deleteEntry(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {toast && (
        <div className={cn(
          'fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all',
          toast.type === 'success'
            ? 'bg-emerald-500/90 text-white'
            : 'bg-destructive/90 text-destructive-foreground'
        )}>
          {toast.message}
          <button onClick={() => setToast(null)} aria-label="Close notification" className="ml-2 opacity-70 hover:opacity-100 text-xs">✕</button>
        </div>
      )}
    </div>
  )
}

function EntryCard({ entry, fields, revealedFields, copiedField, onToggleReveal, onCopy, onDelete }: {
  entry: VaultEntry
  fields: Array<{ key: string; label: string; sensitive?: boolean }>
  revealedFields: Set<string>
  copiedField: string | null
  onToggleReveal: (key: string) => void
  onCopy: (val: string, key: string) => void
  onDelete: () => void
}): JSX.Element {
  const entryName = (entry.institution || entry.service || entry.documentType || entry.type || 'Entry') as string

  return (
    <div className="bg-card border border-border rounded-xl p-5 group">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">{entryName}</h3>
        <button
          onClick={onDelete}
          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {fields.map(field => {
          const value = entry[field.key] as string | undefined
          if (!value) return null
          const fieldId = `${entry.id}-${field.key}`
          const isRevealed = revealedFields.has(fieldId)
          const isCopied = copiedField === fieldId

          return (
            <div key={field.key}>
              <p className="text-xs text-muted-foreground mb-0.5">{field.label}</p>
              <div className="flex items-center gap-1.5">
                <span className={cn('text-sm text-foreground flex-1', field.sensitive && !isRevealed && 'font-mono tracking-wider')}>
                  {field.sensitive && !isRevealed ? '••••••••' : value}
                </span>
                {field.sensitive && (
                  <button
                    onClick={() => onToggleReveal(fieldId)}
                    className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {isRevealed ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                )}
                <button
                  onClick={() => onCopy(value, fieldId)}
                  className={cn('p-0.5 transition-colors', isCopied ? 'text-emerald-400' : 'text-muted-foreground hover:text-foreground')}
                >
                  <Copy size={11} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
