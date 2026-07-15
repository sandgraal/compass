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
import DerivedEntityList from '../components/DerivedEntityList'
import ContactsOverview from '../components/contacts/ContactsOverview'
import MergeContactsDialog, {
  type MergeCandidate
} from '../components/contacts/MergeContactsDialog'
import SetRelationshipDialog from '../components/contacts/SetRelationshipDialog'
import WebEnrichDialog from '../components/contacts/WebEnrichDialog'
import BulkActionBar from '../components/ui/BulkActionBar'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { WEB_ENRICH_STALE_MONTHS, cn, formatRelative, monthsSince } from '../lib/utils'

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

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Rows mounted per increment. Selection/sort/filter always operate on the full
 * in-memory array — only the DOM is windowed, so select-all and shift-ranges
 * stay exact while a many-thousand-contact book renders instantly.
 */
const RENDER_CHUNK = 200

type ContactsTab = 'tracked' | 'discovered'

export default function Contacts(): JSX.Element {
  // Mirrors Merchants/Places: undecided until the first load resolves, so a
  // contactless first run lands on Discovered instead of a blank address book.
  const [tab, setTab] = useState<ContactsTab | null>(null)
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null)
  const [contacts, setContacts] = useState<ContactRecord[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selected, setSelected] = useState<ContactRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ContactInput>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [webEnrichOpen, setWebEnrichOpen] = useState(false)
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
  // A duplicates-panel pair under review — feeds MergeContactsDialog directly
  // instead of hijacking the checkbox selection.
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[] | null>(null)
  const [relationshipOpen, setRelationshipOpen] = useState(false)
  // Bulk "Enrich from web": the queue is driven strictly one contact at a time —
  // the IPC is single-flight with one cached run slot (contact-web-enrich.ts).
  const [enrichQueue, setEnrichQueue] = useState<ContactRecord[] | null>(null)
  const [enrichIndex, setEnrichIndex] = useState(0)
  // How many rows are mounted — bumped by the list-end sentinel so a
  // thousands-strong address book doesn't render thousands of DOM rows at once.
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK)
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  // Monotonic token so a slow response from an earlier click can't overwrite the
  // selection/activity of a newer one (openContact does async IPC).
  const openSeq = useRef(0)
  const selectAllRef = useRef<HTMLInputElement>(null)
  // Last checkbox clicked — the anchor a shift-click ranges from.
  const selectAnchor = useRef<number | null>(null)
  const listEndRef = useRef<HTMLDivElement | null>(null)

  const openTimeline = (query: string): void => navigate(`/timeline?q=${encodeURIComponent(query)}`)

  // Debounced: typing re-queries SQLite, so don't fire per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      void load(search)
    }, 150)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Land on Tracked once it has content, otherwise show Discovered — same
  // heuristic as Merchants/Places, decided once the first load resolves.
  useEffect(() => {
    if (tab != null || loading) return
    setTab(contacts.length > 0 ? 'tracked' : 'discovered')
  }, [tab, loading, contacts.length])

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

  // Collapse the DOM window whenever the displayed list changes (search /
  // filter / sort / reload) — the sentinel re-expands it as the user scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the list identity on purpose
  useEffect(() => {
    setVisibleCount(RENDER_CHUNK)
  }, [shown])

  useEffect(() => {
    const el = listEndRef.current
    if (!el || visibleCount >= shown.length) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisibleCount((n) => Math.min(n + RENDER_CHUNK, shown.length))
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [visibleCount, shown.length])

  const allShownSelected = shown.length > 0 && shown.every((c) => selectedRows.has(c.id))
  const someShownSelected = shown.some((c) => selectedRows.has(c.id))
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someShownSelected && !allShownSelected
    }
  }, [someShownSelected, allShownSelected])

  function toggleSelect(c: ContactRecord, shiftKey = false): void {
    setSelectedRows((prev) => {
      const next = new Map(prev)
      if (shiftKey && selectAnchor.current != null && selectAnchor.current !== c.id) {
        const ai = shown.findIndex((x) => x.id === selectAnchor.current)
        const bi = shown.findIndex((x) => x.id === c.id)
        if (ai !== -1 && bi !== -1) {
          // The range takes the anchor's state: shift-click extends a selection
          // when the anchor is checked, clears the run when it isn't.
          const selecting = prev.has(selectAnchor.current)
          const [from, to] = ai < bi ? [ai, bi] : [bi, ai]
          for (let i = from; i <= to; i++) {
            if (selecting) next.set(shown[i].id, shown[i])
            else next.delete(shown[i].id)
          }
          return next
        }
      }
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
    selectAnchor.current = c.id
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
    setMergeCandidates(null)
    clearSelection()
    await load(search)
    await loadDupes()
    await openContact(survivorId)
  }

  /** Route a duplicates-panel pair into the merge dialog (survivor picker +
   *  smart default) instead of the old blind keep-side-A merge. */
  function reviewPair(pair: DuplicatePair): void {
    setMergeCandidates([pair.a, pair.b])
    setMergeOpen(true)
  }

  /** A person promoted from Discovered — refresh Tracked in the background,
   * but stay on Discovered so adding one person doesn't yank the user away
   * from the rest of the list they were working through. */
  async function handlePersonPromoted(): Promise<void> {
    await load(search)
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

  /** Bulk "Enrich from web": strictly sequential — one consent→review dialog
   *  per selected contact (the enrichment IPC holds a single cached run). */
  async function startBulkEnrich(): Promise<void> {
    if (!isElectron() || selectedRows.size === 0) return
    try {
      const s = await window.api.assistant.getStatus()
      if (!s.configuredProviders.includes('anthropic')) {
        toast(
          'Web enrichment needs an Anthropic API key — add one in Settings → AI assist.',
          'info'
        )
        return
      }
    } catch {
      /* the dialog re-checks per contact */
    }
    const n = selectedRows.size
    const ok = await confirm({
      title: `Search the web for ${n} contact${n === 1 ? '' : 's'}?`,
      description:
        'Each contact runs one Anthropic web search on your API key and asks for your review — nothing is saved without it. You can stop the run at any point.',
      confirmLabel: 'Start'
    })
    if (!ok) return
    setEnrichQueue([...selectedRows.values()])
    setEnrichIndex(0)
  }

  function advanceEnrichQueue(): void {
    if (!enrichQueue) return
    const next = enrichIndex + 1
    if (next >= enrichQueue.length) {
      setEnrichQueue(null)
      setEnrichIndex(0)
    } else {
      setEnrichIndex(next)
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
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border px-4 pt-3 shrink-0">
        {(
          [
            { key: 'tracked' as ContactsTab, label: 'Tracked', count: contacts.length },
            { key: 'discovered' as ContactsTab, label: 'Discovered', count: discoveredCount }
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
        <div className="flex-1 min-h-0 overflow-y-auto p-8 pt-6 max-w-3xl mx-auto w-full">
          <DerivedEntityList
            kind="person"
            searchPlaceholder="Find a person…"
            onCount={setDiscoveredCount}
            promoteLabel="Add"
            promotedLabel="Added"
            onPromoted={handlePersonPromoted}
            emptyState={
              <>
                No people yet. Import your <span className="text-foreground">LinkedIn</span>,{' '}
                <span className="text-foreground">Facebook</span>, or{' '}
                <span className="text-foreground">Google Voice</span> archive on the Timeline, or
                connect Gmail.
              </>
            }
          />
        </div>
      )}

      {tab !== 'discovered' && (
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
                      selectedRows.size < 2
                        ? 'Select at least two contacts to merge'
                        : 'Merge into one'
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
                    onClick={() => void startBulkEnrich()}
                    disabled={bulkBusy || enrichQueue != null}
                    aria-label="Enrich selection from web"
                    title="Enrich from web, one at a time (uses your Anthropic key)"
                    className="flex items-center gap-1 text-xs px-2 py-1.5 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Sparkles size={12} />
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
                shown.slice(0, visibleCount).map((c) => (
                  <div key={c.id} className="flex items-center gap-0.5">
                    <label className="pl-1.5 py-2 shrink-0 flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedRows.has(c.id)}
                        // onClick (not onChange) so shift-click ranges work —
                        // change events don't carry modifier keys.
                        onClick={(e) => toggleSelect(c, e.shiftKey)}
                        readOnly
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
              {!loading && visibleCount < shown.length && (
                <div ref={listEndRef} className="py-3 text-center text-xs text-muted-foreground">
                  {shown.length - visibleCount} more…
                </div>
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
                title={
                  selectedRows.size > 0 ? 'Export the selected contacts as .vcf' : 'Export .vcf'
                }
              />
              <HeaderButton
                icon={<Download size={11} />}
                label={selectedRows.size > 0 ? `CSV (${selectedRows.size})` : 'CSV'}
                onClick={() => exportTo('csv')}
                disabled={busy}
                title={
                  selectedRows.size > 0 ? 'Export the selected contacts as .csv' : 'Export .csv'
                }
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
                      onClick={() => setWebEnrichOpen(true)}
                      title="Search the public web for this person, then review what to keep"
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-primary/40 hover:border-primary text-primary rounded-lg transition-colors"
                    >
                      <Globe size={12} /> Enrich from web
                    </button>
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
                    Compass needs updated permission to pull in your Google "Other contacts" —
                    everyone you've emailed, not just your saved contacts.
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
                            onClick={() => reviewPair(pair)}
                            title="Pick which contact survives, then merge"
                            className="text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                          >
                            Merge…
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
                  onEnrichWeb={() => setWebEnrichOpen(true)}
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
            contacts={mergeCandidates ?? [...selectedRows.values()]}
            open={mergeOpen}
            onClose={() => {
              setMergeOpen(false)
              setMergeCandidates(null)
            }}
            onMerged={onMerged}
          />
          <SetRelationshipDialog
            count={selectedRows.size}
            open={relationshipOpen}
            busy={bulkBusy}
            onClose={() => setRelationshipOpen(false)}
            onSubmit={bulkSetRelationship}
          />
          {selected && !enrichQueue && (
            <WebEnrichDialog
              contact={selected}
              open={webEnrichOpen}
              onClose={() => setWebEnrichOpen(false)}
              onApplied={async () => {
                await load(search)
                if (selectedId != null) await openContact(selectedId)
              }}
            />
          )}
          {enrichQueue?.[enrichIndex] && (
            <WebEnrichDialog
              // Remount per contact so the dialog's phase machine resets (its
              // reset effect keys on `open`, which stays true across the queue).
              key={enrichQueue[enrichIndex].id}
              contact={enrichQueue[enrichIndex]}
              open
              progress={{ index: enrichIndex + 1, total: enrichQueue.length }}
              onClose={advanceEnrichQueue}
              onStopAll={() => setEnrichQueue(null)}
              onApplied={async () => {
                await load(search)
                if (selectedId != null) await openContact(selectedId)
              }}
            />
          )}
        </div>
      )}
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
  onOpenTimeline,
  onEnrichWeb
}: {
  contact: ContactRecord
  activity: ContactActivityHit[]
  activityLoading: boolean
  onOpenTimeline: (query: string) => void
  onEnrichWeb: () => void
}): JSX.Element {
  const g = contact.enrichment?.google
  const cs = contact.enrichment?.crossSource
  const web = contact.enrichment?.web
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

      {web && (
        <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Globe size={13} className="text-primary" /> Web presence
          </p>
          {web.bio && <p className="text-sm text-foreground whitespace-pre-wrap">{web.bio}</p>}
          {web.location && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <MapPin size={12} /> {web.location}
            </p>
          )}
          {web.links.length > 0 && (
            <div className="space-y-1">
              {web.links.map((l, i) => (
                <DetailRow
                  key={`${l.value}-${i}`}
                  label={l.type}
                  value={l.value}
                  href={safeHref(l.value)}
                />
              ))}
            </div>
          )}
          {web.facts.length > 0 && (
            <ul className="space-y-1">
              {web.facts.map((f, i) => (
                <li key={`${f.text}-${i}`} className="text-sm text-foreground">
                  {f.text}
                  {f.sourceUrl && safeHref(f.sourceUrl) && (
                    <a
                      href={safeHref(f.sourceUrl)}
                      target="_blank"
                      rel="noreferrer"
                      title={f.sourceUrl}
                      className="ml-1.5 text-xs text-primary hover:underline"
                    >
                      {hostnameOf(f.sourceUrl)}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!web.bio && !web.location && web.links.length === 0 && web.facts.length === 0 && (
            <p className="text-xs text-muted-foreground">No web findings were kept.</p>
          )}
          <div className="flex items-center justify-between pt-1">
            <p
              className={cn(
                'text-xs',
                monthsSince(web.refreshedAt) >= WEB_ENRICH_STALE_MONTHS
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
              title={`Searched as: ${web.searchedAs}`}
            >
              {monthsSince(web.refreshedAt) >= WEB_ENRICH_STALE_MONTHS
                ? `Refreshed ${monthsSince(web.refreshedAt)} months ago — worth a refresh`
                : `Refreshed ${formatRelative(web.refreshedAt)}`}
            </p>
            <button
              type="button"
              onClick={onEnrichWeb}
              className="text-xs text-primary hover:underline"
            >
              Re-run
            </button>
          </div>
        </div>
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
