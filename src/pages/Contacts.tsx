import {
  Activity,
  Briefcase,
  Building2,
  Cake,
  CalendarClock,
  Download,
  GitMerge,
  Globe,
  Mail,
  MapPin,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Smartphone,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ContactsOverview from '../components/contacts/ContactsOverview'
import MergeContactsDialog from '../components/contacts/MergeContactsDialog'
import SetRelationshipDialog from '../components/contacts/SetRelationshipDialog'
import BulkActionBar from '../components/ui/BulkActionBar'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn, formatRelative } from '../lib/utils'

type PhoneRow = { type?: string; value: string }
type EmailRow = { type?: string; value: string }
type AddressRow = {
  type?: string
  street?: string
  city?: string
  region?: string
  postalCode?: string
  country?: string
}

const EMPTY_DRAFT: ContactInput = {
  displayName: '',
  org: '',
  jobTitle: '',
  relationship: '',
  birthday: '',
  notes: '',
  url: '',
  phones: [],
  emails: [],
  addresses: []
}

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

type SortBy = 'name' | 'active' | 'added' | 'seen'

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Manual',
  vcard: 'vCard',
  csv: 'CSV',
  macos: 'macOS',
  google: 'Google',
  'google-other': 'Google (other)',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  gvoice: 'Voice',
  nylas: 'Email sync',
  derived: 'From timeline'
}
const sourceLabel = (s: string): string => SOURCE_LABELS[s] ?? s

// Only render http(s) links as clickable — synced/imported urls are untrusted, so a
// `javascript:`/`data:` value must degrade to plain text, never an active href.
const safeHref = (value: string): string | undefined =>
  /^https?:\/\//i.test(value) ? value : undefined

export default function Contacts(): JSX.Element {
  const [contacts, setContacts] = useState<ContactRecord[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selected, setSelected] = useState<ContactRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ContactInput>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [needsReconnect, setNeedsReconnect] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [activity, setActivity] = useState<ContactActivityHit[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [dupes, setDupes] = useState<DuplicatePair[]>([])
  const [dupesBusy, setDupesBusy] = useState(false)
  const [showDupes, setShowDupes] = useState(false)
  // Multi-select: id → record, so the merge dialog can show names/sources even
  // for rows a later search filtered out of the loaded list.
  const [selectedRows, setSelectedRows] = useState<Map<number, ContactRecord>>(new Map())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [relationshipOpen, setRelationshipOpen] = useState(false)
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  // Monotonic token so a slow response from an earlier click can't overwrite the
  // selection/activity of a newer one (openContact does async IPC).
  const openSeq = useRef(0)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const openTimeline = (query: string): void => navigate(`/timeline?q=${encodeURIComponent(query)}`)

  // Debounced: typing re-queries SQLite, so don't fire per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      void load(search)
    }, 150)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  /** The list as displayed: source-filtered, then sorted. Rows arrive name-sorted. */
  const shown = useMemo(() => {
    const filtered = sourceFilter ? contacts.filter((c) => c.source === sourceFilter) : contacts
    if (sortBy === 'name') return filtered
    const byName = (a: ContactRecord, b: ContactRecord): number =>
      a.displayName.localeCompare(b.displayName)
    const arr = [...filtered]
    if (sortBy === 'active')
      arr.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || byName(a, b))
    else if (sortBy === 'added')
      arr.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || byName(a, b))
    else arr.sort((a, b) => b.touchpointCount - a.touchpointCount || byName(a, b))
    return arr
  }, [contacts, sortBy, sourceFilter])

  const sourceCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of contacts) m.set(c.source, (m.get(c.source) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [contacts])

  const allShownSelected = shown.length > 0 && shown.every((c) => selectedRows.has(c.id))
  const someShownSelected = shown.some((c) => selectedRows.has(c.id))
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someShownSelected && !allShownSelected
    }
  }, [someShownSelected, allShownSelected])

  function toggleSelect(c: ContactRecord): void {
    setSelectedRows((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }

  function toggleSelectAllShown(): void {
    setSelectedRows((prev) => {
      const next = new Map(prev)
      if (allShownSelected) for (const c of shown) next.delete(c.id)
      else for (const c of shown) next.set(c.id, c)
      return next
    })
  }

  function clearSelection(): void {
    setSelectedRows(new Map())
  }

  async function bulkDelete(): Promise<void> {
    if (!isElectron() || selectedRows.size === 0 || bulkBusy) return
    const n = selectedRows.size
    const ok = await confirm({
      title: n === 1 ? 'Delete 1 contact?' : `Delete ${n} contacts?`,
      description:
        'They will be permanently removed and never re-imported by a sync. Export first if you want a copy. (Undo the block in Settings → Curation.)',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const r = await window.api.contacts.bulkDelete([...selectedRows.keys()])
      toast(`Deleted ${r.deleted} contact${r.deleted === 1 ? '' : 's'}.`, 'success')
      if (selectedId != null && selectedRows.has(selectedId)) {
        setSelectedId(null)
        setSelected(null)
      }
      clearSelection()
      await load(search)
      await loadDupes()
    } catch (err) {
      console.error('[contacts] bulk delete failed', err)
      toast('Delete failed.', 'error')
    } finally {
      setBulkBusy(false)
    }
  }

  async function bulkSetRelationship(relationship: string): Promise<void> {
    if (!isElectron() || selectedRows.size === 0 || bulkBusy) return
    setBulkBusy(true)
    try {
      const r = await window.api.contacts.bulkSetRelationship(
        [...selectedRows.keys()],
        relationship
      )
      toast(
        relationship
          ? `Set relationship to “${relationship}” on ${r.updated} contact${r.updated === 1 ? '' : 's'}.`
          : `Cleared relationship on ${r.updated} contact${r.updated === 1 ? '' : 's'}.`,
        'success'
      )
      setRelationshipOpen(false)
      clearSelection()
      await load(search)
      if (selectedId != null) await openContact(selectedId)
    } catch (err) {
      console.error('[contacts] bulk set relationship failed', err)
      toast('Could not set the relationship.', 'error')
    } finally {
      setBulkBusy(false)
    }
  }

  async function onMerged(survivorId: number): Promise<void> {
    setMergeOpen(false)
    clearSelection()
    await load(search)
    await loadDupes()
    await openContact(survivorId)
  }

  // Proactively surface the reconnect prompt on load if a contacts scope is missing.
  useEffect(() => {
    if (!isElectron()) return
    window.api.contacts
      .enrichStatus()
      .then((s) => setNeedsReconnect(s.needsReconnect))
      .catch(() => {})
    void loadDupes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadDupes(): Promise<void> {
    if (!isElectron()) return
    try {
      setDupes(await window.api.contacts.duplicates())
    } catch (err) {
      console.error('[contacts] duplicates failed', err)
    }
  }

  async function mergePair(pair: DuplicatePair, survivorId: number): Promise<void> {
    if (!isElectron()) return
    const survivorName = survivorId === pair.a.id ? pair.a.displayName : pair.b.displayName
    const loserName = survivorId === pair.a.id ? pair.b.displayName : pair.a.displayName
    const ok = await confirm({
      title: 'Merge contacts?',
      description: `"${loserName}" will be merged into "${survivorName}" and permanently deleted. This cannot be undone.`,
      confirmLabel: 'Merge'
    })
    if (!ok) return
    setDupesBusy(true)
    try {
      const loserId = survivorId === pair.a.id ? pair.b.id : pair.a.id
      const r = await window.api.contacts.merge(survivorId, [loserId])
      if (r.success) {
        toast(
          `Merged into ${survivorId === pair.a.id ? pair.a.displayName : pair.b.displayName}.`,
          'success'
        )
        setDupes((prev) => prev.filter((p) => p.a.id !== loserId && p.b.id !== loserId))
        await load(search)
        await loadDupes()
        if (selectedId === loserId) {
          setSelectedId(null)
          setSelected(null)
        }
      } else {
        toast('Merge failed.', 'error')
      }
    } catch (err) {
      console.error('[contacts] merge failed', err)
      toast('Merge failed.', 'error')
    } finally {
      setDupesBusy(false)
    }
  }

  async function dismissPair(pair: DuplicatePair): Promise<void> {
    if (!isElectron()) return
    setDupesBusy(true)
    try {
      await window.api.contacts.dismissDuplicate(pair.a.externalId, pair.b.externalId)
      setDupes((prev) => prev.filter((p) => p !== pair))
    } catch (err) {
      console.error('[contacts] dismiss failed', err)
    } finally {
      setDupesBusy(false)
    }
  }

  async function load(q = ''): Promise<void> {
    setLoading(true)
    try {
      if (!isElectron()) {
        setContacts([])
        return
      }
      const rows = await window.api.contacts.list(q ? { search: q } : undefined)
      setContacts(rows)
    } catch (err) {
      console.error('[contacts] list failed', err)
      toast('Failed to load contacts.', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function openContact(id: number): Promise<void> {
    const seq = ++openSeq.current
    setSelectedId(id)
    setEditing(false)
    setActivity([])
    if (!isElectron()) return
    try {
      const rec = await window.api.contacts.get(id)
      if (openSeq.current !== seq) return // superseded by a newer selection
      setSelected(rec)
    } catch (err) {
      if (openSeq.current === seq) console.error('[contacts] get failed', err)
      return
    }
    // Lazily load the live "recent activity" feed for this contact.
    setActivityLoading(true)
    try {
      const hits = await window.api.contacts.activity(id)
      if (openSeq.current !== seq) return
      setActivity(hits)
    } catch (err) {
      if (openSeq.current === seq) {
        console.error('[contacts] activity failed', err)
        setActivity([])
      }
    } finally {
      if (openSeq.current === seq) setActivityLoading(false)
    }
  }

  async function enrichAll(): Promise<void> {
    if (!isElectron()) return
    setEnriching(true)
    try {
      const r = await window.api.contacts.enrichAll()
      if (r.success) {
        setNeedsReconnect(r.needsReconnect)
        const parts: string[] = []
        if (r.imported > 0) parts.push(`imported ${r.imported} new`)
        if (r.enriched > 0) parts.push(`enriched ${r.enriched}`)
        const summary =
          parts.length > 0
            ? `Contacts: ${parts.join(', ')}.`
            : r.needsReconnect
              ? 'No new contacts — reconnect Google to pull your full address book.'
              : 'No new contacts.'
        // Always append the honest per-source breakdown (e.g. Google's actual error)
        // so a zero-result never leaves the user guessing. `success` when any work
        // happened (imported OR enriched), else `info`.
        const didWork = r.imported > 0 || r.enriched > 0
        toast(r.message ? `${summary} ${r.message}` : summary, didWork ? 'success' : 'info')
        await load(search)
        await loadDupes()
        if (selectedId != null) await openContact(selectedId)
      } else {
        toast(`Pull failed: ${r.error ?? 'unknown error'}`, 'error')
      }
    } catch (err) {
      console.error('[contacts] enrich-all failed', err)
      toast('Pull failed.', 'error')
    } finally {
      setEnriching(false)
    }
  }

  // Re-run the Google OAuth consent to grant the contacts scopes (a token refresh
  // never widens scopes), then immediately pull everything.
  async function reconnectGoogle(): Promise<void> {
    if (!isElectron()) return
    setReconnecting(true)
    try {
      const res = await window.api.auth.connectGoogle()
      if (res.error) {
        toast(`Google reconnect failed: ${res.error}`, 'error')
        return
      }
      setNeedsReconnect(false)
      await enrichAll()
    } catch (err) {
      console.error('[contacts] google reconnect failed', err)
      toast('Google reconnect failed.', 'error')
    } finally {
      setReconnecting(false)
    }
  }

  function startAdd(): void {
    setSelectedId(null)
    setSelected(null)
    setDraft({ ...EMPTY_DRAFT })
    setEditing(true)
  }

  function startEdit(): void {
    if (!selected) return
    setDraft({
      displayName: selected.displayName,
      givenName: selected.givenName ?? '',
      familyName: selected.familyName ?? '',
      org: selected.org ?? '',
      jobTitle: selected.jobTitle ?? '',
      relationship: selected.relationship ?? '',
      birthday: selected.birthday ?? '',
      notes: selected.notes ?? '',
      url: selected.url ?? '',
      phones: selected.phones ?? [],
      emails: selected.emails ?? [],
      addresses: selected.addresses ?? []
    })
    setEditing(true)
  }

  async function save(): Promise<void> {
    if (!isElectron()) return
    const name =
      draft.displayName?.trim() ||
      [draft.givenName, draft.familyName].filter(Boolean).join(' ').trim() ||
      draft.org?.trim()
    if (!name) {
      toast('A contact needs at least a name or organization.', 'error')
      return
    }
    setBusy(true)
    try {
      const payload = { ...draft, displayName: name }
      if (selectedId == null) {
        const { id } = await window.api.contacts.create(payload)
        toast('Contact added.', 'success')
        await load(search)
        await openContact(id)
      } else {
        await window.api.contacts.update(selectedId, payload)
        toast('Contact saved.', 'success')
        await load(search)
        await openContact(selectedId)
      }
      setEditing(false)
    } catch (err) {
      console.error('[contacts] save failed', err)
      toast('Failed to save contact.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (selectedId == null || !isElectron()) return
    const ok = await confirm({
      title: 'Delete contact?',
      description: `${selected?.displayName ?? 'This contact'} will be permanently removed. Export first if you want a copy.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    await window.api.contacts.delete(selectedId)
    setSelected(null)
    setSelectedId(null)
    await load(search)
  }

  async function importFrom(
    kind: 'vcard' | 'csv' | 'linkedin' | 'facebook' | 'gvoice'
  ): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      const api = window.api.contacts
      const fn = {
        vcard: api.importVcard,
        csv: api.importCsv,
        linkedin: api.importLinkedin,
        facebook: api.importFacebook,
        gvoice: api.importGvoice
      }[kind]
      const r = await fn()
      if (r.canceled) return
      if (r.success) {
        const added = r.imported ?? 0
        const updated = r.updated ?? 0
        toast(`Imported ${added} new, updated ${updated} contact(s).`, 'success')
        await load(search)
        await loadDupes()
      } else {
        toast(`Import failed: ${r.error}`, 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  async function exportTo(kind: 'vcard' | 'csv'): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      // With a selection active, export exactly the ticked contacts; otherwise the whole book.
      const ids = selectedRows.size > 0 ? [...selectedRows.keys()] : undefined
      const r =
        kind === 'vcard'
          ? await window.api.contacts.exportVcard(ids)
          : await window.api.contacts.exportCsv(ids)
      if (r.canceled) return
      if (r.success) {
        toast(`Exported ${r.count ?? 0} contact(s).`, 'success')
      } else {
        toast(`Export failed: ${r.error}`, 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full pt-10">
      {/* List panel */}
      <div className="w-72 shrink-0 border-r border-border bg-card/40 flex flex-col pt-4">
        <div className="px-4 pb-3 flex items-center gap-2">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allShownSelected}
            onChange={toggleSelectAllShown}
            disabled={shown.length === 0}
            aria-label="Select all shown contacts"
            title="Select all shown"
            className="h-3.5 w-3.5 accent-primary cursor-pointer disabled:cursor-default"
          />
          <Users size={14} className="text-primary" />
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Contacts
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{shown.length}</span>
        </div>

        <div className="px-3 pb-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, phone…"
            aria-label="Search contacts"
            className="w-full bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="px-3 pb-2 flex items-center gap-1.5">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            aria-label="Sort contacts"
            className="flex-1 bg-secondary border border-border rounded-lg px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            <option value="name">Sort: Name</option>
            <option value="active">Sort: Recently active</option>
            <option value="added">Sort: Recently added</option>
            <option value="seen">Sort: Most seen</option>
          </select>
        </div>

        {sourceCounts.length > 1 && (
          <div className="px-3 pb-2 flex gap-1.5 overflow-x-auto">
            <button
              type="button"
              onClick={() => setSourceFilter(null)}
              className={cn(
                'shrink-0 text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                sourceFilter === null
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              )}
            >
              All
            </button>
            {sourceCounts.map(([source, count]) => (
              <button
                key={source}
                type="button"
                onClick={() => setSourceFilter((prev) => (prev === source ? null : source))}
                title={`${count} from ${sourceLabel(source)}`}
                className={cn(
                  'shrink-0 text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                  sourceFilter === source
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {sourceLabel(source)} {count}
              </button>
            ))}
          </div>
        )}

        {selectedRows.size > 0 ? (
          <div className="px-3">
            <BulkActionBar
              count={selectedRows.size}
              onClear={clearSelection}
              className="static px-3 py-2 gap-2"
            >
              <button
                type="button"
                onClick={() => setMergeOpen(true)}
                disabled={selectedRows.size < 2 || bulkBusy}
                aria-label={`Merge ${selectedRows.size} contacts`}
                title={
                  selectedRows.size < 2 ? 'Select at least two contacts to merge' : 'Merge into one'
                }
                className="flex items-center gap-1 text-xs px-2 py-1.5 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg transition-colors disabled:opacity-50"
              >
                <GitMerge size={12} />
              </button>
              <button
                type="button"
                onClick={() => setRelationshipOpen(true)}
                disabled={bulkBusy}
                aria-label="Set relationship on selection"
                title="Set relationship (family, coworker…)"
                className="flex items-center gap-1 text-xs px-2 py-1.5 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg transition-colors disabled:opacity-50"
              >
                <Tag size={12} />
              </button>
              <button
                type="button"
                onClick={bulkDelete}
                disabled={bulkBusy}
                aria-label="Delete selection"
                title="Delete selected contacts"
                className="flex items-center gap-1 text-xs px-2 py-1.5 bg-secondary hover:bg-destructive/20 text-foreground hover:text-destructive rounded-lg transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            </BulkActionBar>
          </div>
        ) : (
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => importFrom('vcard')}
              disabled={busy}
              title="Import a .vcf exported from your phone (iCloud / Google / Outlook)"
              className="w-full flex items-center justify-center gap-1.5 text-sm px-3 py-2 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
            >
              <Smartphone size={14} /> Import from phone
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {loading ? (
            [1, 2, 3, 4].map((n) => (
              <div key={n} className="h-12 bg-secondary/30 rounded-lg animate-pulse mb-1" />
            ))
          ) : shown.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-6 text-center">
              {search || sourceFilter ? 'No matches.' : 'No contacts yet.'}
            </p>
          ) : (
            shown.map((c) => (
              <div key={c.id} className="flex items-center gap-0.5">
                <label className="pl-1.5 py-2 shrink-0 flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedRows.has(c.id)}
                    onChange={() => toggleSelect(c)}
                    aria-label={`Select ${c.displayName}`}
                    className="h-3.5 w-3.5 accent-primary cursor-pointer"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => openContact(c.id)}
                  className={cn(
                    'flex-1 min-w-0 flex flex-col items-start gap-0.5 px-2 py-2 rounded-lg text-left transition-colors',
                    selectedId === c.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-secondary/60'
                  )}
                >
                  <span className="text-sm font-medium leading-tight truncate w-full">
                    {c.displayName}
                  </span>
                  {(sortBy === 'active' || sortBy === 'seen') && c.lastSeen != null ? (
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {formatRelative(c.lastSeen)}
                      {c.touchpointCount > 0 && ` · ${c.touchpointCount} touchpoints`}
                    </span>
                  ) : (
                    (c.org || c.relationship) && (
                      <span className="text-xs text-muted-foreground truncate w-full">
                        {[c.org, c.relationship].filter(Boolean).join(' · ')}
                      </span>
                    )
                  )}
                </button>
              </div>
            ))
          )}
        </div>

        <div className="px-3 py-3 border-t border-border grid grid-cols-2 gap-1.5">
          <HeaderButton
            icon={<Upload size={11} />}
            label="vCard"
            onClick={() => importFrom('vcard')}
            disabled={busy}
            title="Import .vcf"
          />
          <HeaderButton
            icon={<Upload size={11} />}
            label="CSV"
            onClick={() => importFrom('csv')}
            disabled={busy}
            title="Import .csv"
          />
          <HeaderButton
            icon={<Download size={11} />}
            label={selectedRows.size > 0 ? `vCard (${selectedRows.size})` : 'vCard'}
            onClick={() => exportTo('vcard')}
            disabled={busy}
            title={selectedRows.size > 0 ? 'Export the selected contacts as .vcf' : 'Export .vcf'}
          />
          <HeaderButton
            icon={<Download size={11} />}
            label={selectedRows.size > 0 ? `CSV (${selectedRows.size})` : 'CSV'}
            onClick={() => exportTo('csv')}
            disabled={busy}
            title={selectedRows.size > 0 ? 'Export the selected contacts as .csv' : 'Export .csv'}
          />
        </div>

        <div className="px-3 pb-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1.5 px-0.5">
            Import from a service
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <HeaderButton
              icon={<Building2 size={11} />}
              label="LinkedIn"
              onClick={() => importFrom('linkedin')}
              disabled={busy}
              title="Import LinkedIn Connections.csv (from 'Get a copy of your data')"
            />
            <HeaderButton
              icon={<Users size={11} />}
              label="Facebook"
              onClick={() => importFrom('facebook')}
              disabled={busy}
              title="Import friends.json (from 'Download Your Information')"
            />
            <HeaderButton
              icon={<Phone size={11} />}
              label="Voice"
              onClick={() => importFrom('gvoice')}
              disabled={busy}
              title="Import Google Voice numbers (pick your Takeout Voice folder)"
            />
          </div>
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h1 className="text-base font-semibold text-foreground">
            {editing
              ? selectedId == null
                ? 'New contact'
                : 'Edit contact'
              : (selected?.displayName ?? 'Contacts')}
          </h1>
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                type="button"
                onClick={enrichAll}
                disabled={enriching || reconnecting}
                title="Pull your whole Google address book + cross-reference every connected source"
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-primary/40 hover:border-primary text-primary rounded-lg transition-colors disabled:opacity-50"
              >
                <Sparkles size={12} className={cn(enriching && 'animate-pulse')} />
                {enriching ? 'Pulling…' : 'Pull everything'}
              </button>
            )}
            {!editing && selected && (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  aria-label="Edit contact"
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors"
                >
                  <Pencil size={12} /> Edit
                </button>
                <button
                  type="button"
                  onClick={remove}
                  aria-label="Delete contact"
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-border hover:border-destructive/50 text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={startAdd}
              className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        {needsReconnect && !editing && (
          <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <Sparkles size={16} className="text-amber-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                Reconnect Google to import your full address book
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Compass needs updated permission to pull in your Google "Other contacts" — everyone
                you've emailed, not just your saved contacts.
              </p>
            </div>
            <button
              type="button"
              onClick={reconnectGoogle}
              disabled={reconnecting || enriching}
              className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-600 dark:text-amber-400 rounded-lg transition-colors disabled:opacity-50"
            >
              {reconnecting ? 'Reconnecting…' : 'Reconnect Google'}
            </button>
          </div>
        )}

        {dupes.length > 0 && !editing && (
          <div className="mx-6 mt-4 rounded-lg border border-border bg-card/40">
            <button
              type="button"
              onClick={() => setShowDupes((v) => !v)}
              aria-expanded={showDupes}
              className="w-full flex items-center gap-2 px-4 py-3 text-left"
            >
              <Users size={14} className="text-primary shrink-0" />
              <span className="text-sm font-medium text-foreground">
                Possible duplicates ({dupes.length})
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {showDupes ? 'Hide' : 'Review'}
              </span>
            </button>
            {showDupes && (
              <div className="border-t border-border divide-y divide-border">
                {dupes.slice(0, 20).map((pair) => (
                  <div
                    key={`${pair.a.externalId}::${pair.b.externalId}`}
                    className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2"
                  >
                    <div className="flex-1 min-w-0 grid grid-cols-2 gap-3">
                      {[pair.a, pair.b].map((side) => (
                        <div key={side.externalId} className="min-w-0">
                          <p className="text-sm text-foreground truncate">{side.displayName}</p>
                          <p className="text-xs text-muted-foreground truncate capitalize">
                            {side.source}
                            {side.emails[0] ? ` · ${side.emails[0]}` : ''}
                            {!side.emails[0] && side.phones[0] ? ` · ${side.phones[0]}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={dupesBusy}
                        onClick={() => mergePair(pair, pair.a.id)}
                        title={`Keep ${pair.a.displayName}, fold the other in`}
                        className="text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                      >
                        Merge
                      </button>
                      <button
                        type="button"
                        disabled={dupesBusy}
                        onClick={() => dismissPair(pair)}
                        className="text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
                      >
                        Not the same
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          {editing ? (
            <ContactForm
              draft={draft}
              setDraft={setDraft}
              onSave={save}
              onCancel={() => setEditing(false)}
              busy={busy}
            />
          ) : selected ? (
            <ContactDetail
              contact={selected}
              activity={activity}
              activityLoading={activityLoading}
              onOpenTimeline={openTimeline}
            />
          ) : contacts.length > 0 ? (
            <ContactsOverview
              contacts={contacts}
              dupeCount={dupes.length}
              sourceLabel={sourceLabel}
              onFilterSource={(s) => setSourceFilter(s)}
              onOpenContact={(id) => void openContact(id)}
              onReviewDupes={() => setShowDupes(true)}
            />
          ) : (
            <EmptyState onAdd={startAdd} onImport={() => importFrom('vcard')} />
          )}
        </div>
      </div>

      <MergeContactsDialog
        contacts={[...selectedRows.values()]}
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        onMerged={onMerged}
      />
      <SetRelationshipDialog
        count={selectedRows.size}
        open={relationshipOpen}
        busy={bulkBusy}
        onClose={() => setRelationshipOpen(false)}
        onSubmit={bulkSetRelationship}
      />
    </div>
  )
}

function HeaderButton({
  icon,
  label,
  onClick,
  disabled,
  title
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
    >
      {icon} {label}
    </button>
  )
}

function EmptyState({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }): JSX.Element {
  return (
    <div className="max-w-lg mx-auto py-6">
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary">
          <Smartphone size={26} />
        </div>
        <div>
          <p className="text-base font-semibold text-foreground">Import contacts from your phone</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Export a <span className="font-mono text-foreground">.vcf</span> from your phone or
            account, then choose it below. Everything stays on your machine.
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PhoneImportGuide
          title="iPhone / iCloud"
          steps={[
            'Open icloud.com/contacts',
            'Gear icon (bottom-left) → Select All',
            'Gear icon → Export vCard'
          ]}
        />
        <PhoneImportGuide
          title="Android / Google"
          steps={['Open contacts.google.com', 'Left sidebar → Export', 'Choose vCard → Export']}
        />
      </div>

      <div className="mt-6 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={onImport}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
        >
          <Upload size={14} /> Choose .vcf file
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 border border-border hover:border-primary/50 text-foreground rounded-lg transition-colors"
        >
          <UserPlus size={14} /> Add by hand
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/70 text-center mt-3">
        Works with any .vcf from iCloud, Google, Outlook, or a phone export.
      </p>
    </div>
  )
}

function PhoneImportGuide({ title, steps }: { title: string; steps: string[] }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3 text-left">
      <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
        <Smartphone size={13} className="text-primary" /> {title}
      </p>
      <ol className="mt-2 text-xs text-muted-foreground space-y-1 list-decimal list-inside">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  )
}

function ContactDetail({
  contact,
  activity,
  activityLoading,
  onOpenTimeline
}: {
  contact: ContactRecord
  activity: ContactActivityHit[]
  activityLoading: boolean
  onOpenTimeline: (query: string) => void
}): JSX.Element {
  const g = contact.enrichment?.google
  const cs = contact.enrichment?.crossSource
  const links: { type?: string; value: string }[] = [
    ...(contact.url ? [{ value: contact.url }] : []),
    ...(g?.urls ?? []).filter((u) => u.value !== contact.url)
  ]
  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-start gap-4">
        {contact.photo && (
          // Photo is a locally-stored data URI (see contact-enrich.ts) — no network at render.
          <img
            src={contact.photo}
            alt={contact.displayName}
            className="w-16 h-16 rounded-full object-cover border border-border shrink-0"
          />
        )}
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-foreground">{contact.displayName}</h2>
          {g?.nicknames && g.nicknames.length > 0 && (
            <p className="text-sm text-muted-foreground mt-0.5">“{g.nicknames.join('”, “')}”</p>
          )}
          {(contact.jobTitle || contact.org) && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1">
              <Building2 size={13} />
              {[contact.jobTitle, contact.org].filter(Boolean).join(' · ')}
            </p>
          )}
          {contact.relationship && (
            <span className="inline-block mt-2 text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground capitalize">
              {contact.relationship}
            </span>
          )}
        </div>
      </div>

      {cs && cs.sources.length > 0 && (
        <button
          type="button"
          onClick={() => onOpenTimeline(contact.displayName)}
          className="w-full text-left rounded-lg border border-border hover:border-primary/50 bg-secondary/40 px-3 py-2.5 transition-colors"
        >
          <p className="text-sm text-foreground flex items-center gap-1.5">
            <Activity size={13} className="text-primary" />
            Seen across {cs.sources.length} source{cs.sources.length === 1 ? '' : 's'}
            <span className="text-muted-foreground">· {cs.touchpointCount} touchpoints</span>
          </p>
          <p className="text-xs text-muted-foreground mt-1 capitalize">{cs.sources.join(', ')}</p>
        </button>
      )}

      {g?.biography && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
            About
          </p>
          <p className="text-sm text-foreground whitespace-pre-wrap">{g.biography}</p>
        </div>
      )}

      {contact.phones.length > 0 && (
        <DetailGroup icon={<Phone size={14} />} title="Phone">
          {contact.phones.map((p, i) => (
            <DetailRow
              key={`${p.value}-${i}`}
              label={p.type}
              value={p.value}
              href={`tel:${p.value}`}
            />
          ))}
        </DetailGroup>
      )}
      {contact.emails.length > 0 && (
        <DetailGroup icon={<Mail size={14} />} title="Email">
          {contact.emails.map((e, i) => (
            <DetailRow
              key={`${e.value}-${i}`}
              label={e.type}
              value={e.value}
              href={`mailto:${e.value}`}
            />
          ))}
        </DetailGroup>
      )}
      {contact.addresses.length > 0 && (
        <DetailGroup icon={<MapPin size={14} />} title="Address">
          {contact.addresses.map((a) => {
            const value = [a.street, a.city, a.region, a.postalCode, a.country]
              .filter(Boolean)
              .join(', ')
            return <DetailRow key={`${a.type ?? ''}|${value}`} label={a.type} value={value} />
          })}
        </DetailGroup>
      )}
      {contact.birthday && (
        <DetailGroup icon={<Cake size={14} />} title="Birthday">
          <DetailRow value={contact.birthday} />
        </DetailGroup>
      )}
      {links.length > 0 && (
        <DetailGroup icon={<Globe size={14} />} title="Links">
          {links.map((u, i) => (
            <DetailRow
              key={`${u.value}-${i}`}
              label={u.type}
              value={u.value}
              href={safeHref(u.value)}
            />
          ))}
        </DetailGroup>
      )}
      {g?.imHandles && g.imHandles.length > 0 && (
        <DetailGroup icon={<MessageCircle size={14} />} title="Messaging">
          {g.imHandles.map((im, i) => (
            <DetailRow key={`${im.username}-${i}`} label={im.protocol} value={im.username} />
          ))}
        </DetailGroup>
      )}
      {g?.relations && g.relations.length > 0 && (
        <DetailGroup icon={<Users size={14} />} title="Relationships">
          {g.relations.map((r, i) => (
            <DetailRow key={`${r.person}-${i}`} label={r.type} value={r.person} />
          ))}
        </DetailGroup>
      )}
      {g?.importantDates && g.importantDates.length > 0 && (
        <DetailGroup icon={<CalendarClock size={14} />} title="Dates">
          {g.importantDates.map((d, i) => (
            <DetailRow key={`${d.date}-${i}`} label={d.type} value={d.date} />
          ))}
        </DetailGroup>
      )}
      {((g?.occupations && g.occupations.length > 0) ||
        (g?.organizations && g.organizations.length > 0)) && (
        <DetailGroup icon={<Briefcase size={14} />} title="Work">
          {(g?.occupations ?? []).map((o) => (
            <DetailRow key={`occ-${o}`} value={o} />
          ))}
          {(g?.organizations ?? []).map((o) => (
            <DetailRow
              key={`org-${o.name ?? o.title}`}
              label={o.title}
              value={o.name ?? o.title ?? ''}
            />
          ))}
        </DetailGroup>
      )}
      {g?.googleLabels && g.googleLabels.length > 0 && (
        <DetailGroup icon={<Tag size={14} />} title="Labels">
          <div className="flex flex-wrap gap-1.5">
            {g.googleLabels.map((label) => (
              <span
                key={label}
                className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </DetailGroup>
      )}
      {contact.notes && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Notes
          </p>
          <p className="text-sm text-foreground whitespace-pre-wrap">{contact.notes}</p>
        </div>
      )}
      {(activityLoading || activity.length > 0) && (
        <DetailGroup icon={<Activity size={14} />} title="Recent activity">
          {activityLoading ? (
            <p className="text-xs text-muted-foreground">Looking across your timeline…</p>
          ) : (
            activity.map((a) => (
              <button
                type="button"
                key={a.recordId}
                onClick={() => onOpenTimeline(contact.displayName)}
                className="w-full flex items-baseline justify-between gap-3 text-left rounded-md px-2 py-1 -mx-2 hover:bg-secondary/60 transition-colors"
              >
                <span className="text-sm text-foreground truncate">{a.title}</span>
                <span className="text-xs text-muted-foreground shrink-0 capitalize">
                  {a.source}
                  {a.occurredAt ? ` · ${new Date(a.occurredAt).toLocaleDateString()}` : ''}
                </span>
              </button>
            ))
          )}
        </DetailGroup>
      )}
    </div>
  )
}

function DetailGroup({
  icon,
  title,
  children
}: { icon: React.ReactNode; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
        {icon} {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  href
}: { label?: string; value: string; href?: string }): JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      {label && (
        <span className="text-xs text-muted-foreground capitalize w-16 shrink-0">{label}</span>
      )}
      {href ? (
        <a href={href} className="text-sm text-primary hover:underline">
          {value}
        </a>
      ) : (
        <span className="text-sm text-foreground">{value}</span>
      )}
    </div>
  )
}

function ContactForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy
}: {
  draft: ContactInput
  setDraft: (d: ContactInput) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
}): JSX.Element {
  const phones = draft.phones ?? []
  const emails = draft.emails ?? []
  const addresses = draft.addresses ?? []

  return (
    <div className="max-w-2xl space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Display name"
          value={draft.displayName}
          onChange={(v) => setDraft({ ...draft, displayName: v })}
        />
        <Field
          label="Relationship"
          value={draft.relationship ?? ''}
          onChange={(v) => setDraft({ ...draft, relationship: v })}
          placeholder="friend, family…"
        />
        <Field
          label="First name"
          value={draft.givenName ?? ''}
          onChange={(v) => setDraft({ ...draft, givenName: v })}
        />
        <Field
          label="Last name"
          value={draft.familyName ?? ''}
          onChange={(v) => setDraft({ ...draft, familyName: v })}
        />
        <Field
          label="Organization"
          value={draft.org ?? ''}
          onChange={(v) => setDraft({ ...draft, org: v })}
        />
        <Field
          label="Job title"
          value={draft.jobTitle ?? ''}
          onChange={(v) => setDraft({ ...draft, jobTitle: v })}
        />
        <Field
          label="Birthday"
          value={draft.birthday ?? ''}
          onChange={(v) => setDraft({ ...draft, birthday: v })}
          placeholder="YYYY-MM-DD"
        />
        <Field
          label="Website"
          value={draft.url ?? ''}
          onChange={(v) => setDraft({ ...draft, url: v })}
        />
      </div>

      <RowEditor<PhoneRow>
        title="Phone numbers"
        items={phones}
        onChange={(next) => setDraft({ ...draft, phones: next })}
        empty={{ type: 'cell', value: '' }}
        render={(item, update) => (
          <>
            <input
              aria-label="Phone type"
              value={item.type ?? ''}
              onChange={(e) => update({ ...item, type: e.target.value })}
              placeholder="cell"
              className="w-20 shrink-0 bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              aria-label="Phone number"
              value={item.value}
              onChange={(e) => update({ ...item, value: e.target.value })}
              placeholder="+1 555 0100"
              className="flex-1 bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </>
        )}
      />

      <RowEditor<EmailRow>
        title="Emails"
        items={emails}
        onChange={(next) => setDraft({ ...draft, emails: next })}
        empty={{ type: 'home', value: '' }}
        render={(item, update) => (
          <>
            <input
              aria-label="Email type"
              value={item.type ?? ''}
              onChange={(e) => update({ ...item, type: e.target.value })}
              placeholder="home"
              className="w-20 shrink-0 bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              aria-label="Email address"
              value={item.value}
              onChange={(e) => update({ ...item, value: e.target.value })}
              placeholder="name@example.com"
              className="flex-1 bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </>
        )}
      />

      <RowEditor<AddressRow>
        title="Addresses"
        items={addresses}
        onChange={(next) => setDraft({ ...draft, addresses: next })}
        empty={{ type: 'home' }}
        render={(item, update) => (
          <div className="flex-1 grid grid-cols-2 gap-2">
            <input
              aria-label="Street"
              value={item.street ?? ''}
              onChange={(e) => update({ ...item, street: e.target.value })}
              placeholder="Street"
              className="col-span-2 bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              aria-label="City"
              value={item.city ?? ''}
              onChange={(e) => update({ ...item, city: e.target.value })}
              placeholder="City"
              className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              aria-label="Region"
              value={item.region ?? ''}
              onChange={(e) => update({ ...item, region: e.target.value })}
              placeholder="State / Region"
              className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              aria-label="Postal code"
              value={item.postalCode ?? ''}
              onChange={(e) => update({ ...item, postalCode: e.target.value })}
              placeholder="ZIP / Postal"
              className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              aria-label="Country"
              value={item.country ?? ''}
              onChange={(e) => update({ ...item, country: e.target.value })}
              placeholder="Country"
              className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}
      />

      <div>
        <label htmlFor="contact-notes" className="text-xs text-muted-foreground mb-1 block">
          Notes
        </label>
        <textarea
          id="contact-notes"
          value={draft.notes ?? ''}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          rows={3}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="flex gap-2 justify-end pt-2">
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
          {busy ? 'Saving…' : 'Save contact'}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): JSX.Element {
  const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <div>
      <label htmlFor={id} className="text-xs text-muted-foreground mb-1 block">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  )
}

function RowEditor<T>({
  title,
  items,
  onChange,
  empty,
  render
}: {
  title: string
  items: T[]
  onChange: (next: T[]) => void
  empty: T
  render: (item: T, update: (next: T) => void) => React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {title}
        </p>
        <button
          type="button"
          onClick={() => onChange([...items, { ...empty }])}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows; controlled inputs keep values correct across add/remove
          <div key={idx} className="flex items-start gap-2">
            {render(item, (next) => onChange(items.map((it, i) => (i === idx ? next : it))))}
            <button
              type="button"
              onClick={() => onChange(items.filter((_, i) => i !== idx))}
              aria-label={`Remove ${title} row`}
              className="p-1.5 text-muted-foreground hover:text-destructive transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
