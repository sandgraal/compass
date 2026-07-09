import {
  Activity,
  Briefcase,
  Building2,
  Cake,
  CalendarClock,
  Download,
  Globe,
  Mail,
  MapPin,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

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
  const [activity, setActivity] = useState<ContactActivityHit[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  // Monotonic token so a slow response from an earlier click can't overwrite the
  // selection/activity of a newer one (openContact does async IPC).
  const openSeq = useRef(0)

  const openTimeline = (query: string): void => navigate(`/timeline?q=${encodeURIComponent(query)}`)

  useEffect(() => {
    void load(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

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
        toast(`Enriched ${r.enriched} contact(s) from your connected sources.`, 'success')
        await load(search)
        if (selectedId != null) await openContact(selectedId)
      } else {
        toast(`Enrich failed: ${r.error ?? 'unknown error'}`, 'error')
      }
    } catch (err) {
      console.error('[contacts] enrich-all failed', err)
      toast('Enrich failed.', 'error')
    } finally {
      setEnriching(false)
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
      const r =
        kind === 'vcard'
          ? await window.api.contacts.exportVcard()
          : await window.api.contacts.exportCsv()
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
          <Users size={14} className="text-primary" />
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Contacts
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{contacts.length}</span>
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

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {loading ? (
            [1, 2, 3, 4].map((n) => (
              <div key={n} className="h-12 bg-secondary/30 rounded-lg animate-pulse mb-1" />
            ))
          ) : contacts.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-6 text-center">
              {search ? 'No matches.' : 'No contacts yet.'}
            </p>
          ) : (
            contacts.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => openContact(c.id)}
                className={cn(
                  'w-full flex flex-col items-start gap-0.5 px-3 py-2 rounded-lg text-left transition-colors',
                  selectedId === c.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-secondary/60'
                )}
              >
                <span className="text-sm font-medium leading-tight">{c.displayName}</span>
                {(c.org || c.relationship) && (
                  <span className="text-xs text-muted-foreground">
                    {[c.org, c.relationship].filter(Boolean).join(' · ')}
                  </span>
                )}
              </button>
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
            label="vCard"
            onClick={() => exportTo('vcard')}
            disabled={busy}
            title="Export .vcf"
          />
          <HeaderButton
            icon={<Download size={11} />}
            label="CSV"
            onClick={() => exportTo('csv')}
            disabled={busy}
            title="Export .csv"
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
                disabled={enriching}
                title="Pull everything Google knows + cross-reference your connected sources"
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-primary/40 hover:border-primary text-primary rounded-lg transition-colors disabled:opacity-50"
              >
                <Sparkles size={12} className={cn(enriching && 'animate-pulse')} />
                {enriching ? 'Enriching…' : 'Enrich all'}
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
          ) : (
            <EmptyState onAdd={startAdd} onImport={() => importFrom('vcard')} />
          )}
        </div>
      </div>
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
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
      <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
        <Users size={28} />
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground">Your address book lives here</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Import a .vcf exported from your phone, Google Contacts, or iCloud — or add someone by
          hand. Everything stays on your machine, and you can export it back out anytime.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onImport}
          className="flex items-center gap-1.5 text-sm px-3 py-2 border border-border hover:border-primary/50 text-foreground rounded-lg transition-colors"
        >
          <Upload size={14} /> Import vCard
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 text-sm px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
        >
          <UserPlus size={14} /> Add contact
        </button>
      </div>
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
