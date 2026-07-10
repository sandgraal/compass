/**
 * Contact enrichment orchestrator — "go out and get everything we can, from
 * everywhere we can."
 *
 * Two tiers over the pure engine in `electron/lib/contact-enrichment.ts`:
 *   - `enrichContactsFromCache()` — CHEAP. A name-join of every contact against
 *     the already-built `derived_entities` person cache. No network, no FTS, never
 *     throws → safe to run after every sync (see `afterConnectorSync`).
 *   - `enrichAllContactsDeep()` — the on-demand deep pass. Adds a per-contact FTS
 *     search of the `records` timeline by each email address to catch touchpoints
 *     the name-key missed, and fills in `lastActivity`.
 *
 * `runEnrichAll()` is the button: refresh Google contacts (widened fields) +
 * reproject the spine, materialize Google photos into local data URIs, then deep
 * enrich, reporting via `sync:update` + a native notification.
 *
 * Everything stays LOCAL — the only outbound calls are to the user's own Google
 * account (via the existing sync path) and to Google's public contact-photo URLs.
 * No third-party people-search / data-broker lookups.
 */
import { eq } from 'drizzle-orm'
import { BrowserWindow, type IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { contacts, derivedEntities } from '../db/schema'
import {
  type EnrichmentPersonEntity,
  type EnrichmentRecordHit,
  computeCrossSourceSummary,
  isEmptySummary,
  parseEnrichment
} from '../lib/contact-enrichment'
import { normalizeName } from '../lib/people'
import { type TimelineSearchHit, searchRecords } from '../lib/records-search'
import { hasGoogleScope, loadToken } from './auth'
import { addContactIdentifiers, writeContactEnrichment } from './contacts'

// Bounds for the deep pass so a huge address book can't wedge the main process.
const MAX_EMAIL_QUERIES = 5 // emails searched per contact
const HITS_PER_QUERY = 25
const MAX_PHOTO_FETCHES = 500 // photos materialized per deep run
const MAX_PHOTO_BYTES = 1_000_000 // ~1MB image (well under the 1.4M-char photo cap)

/**
 * Only fetch photos from Google's own contact-photo CDN. `photoUrl` comes from the
 * People API, but the enrichment blob is stored JSON — an allowlist here means a
 * corrupted/tampered blob can't turn `materializeGooglePhotos` into a main-process
 * SSRF primitive against arbitrary internal hosts.
 */
function isAllowedPhotoUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /(^|\.)googleusercontent\.com$/i.test(u.hostname)
  } catch {
    return false
  }
}

interface ContactActivityHit {
  recordId: number
  source: string
  type: string
  title: string
  occurredAt: number | null
}

interface EnrichContact {
  id: number
  displayName: string
  emails: { value: string }[]
  phones: { value: string }[]
}

function parseValues(json: string | null): { value: string }[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as { value: string }[]).filter((e) => e?.value) : []
  } catch {
    return []
  }
}

/** The `kind='person'` derived-entity cache indexed by its normalized-name key. */
function readPersonEntities(): Map<string, EnrichmentPersonEntity> {
  const rows = getDb()
    .select()
    .from(derivedEntities)
    .where(eq(derivedEntities.kind, 'person'))
    .all()
  const map = new Map<string, EnrichmentPersonEntity>()
  for (const r of rows) {
    let sources: string[] = []
    try {
      sources = JSON.parse(r.sources) as string[]
    } catch {
      sources = []
    }
    map.set(r.matchKey, {
      sources,
      count: r.count,
      firstSeen: r.firstSeen ? r.firstSeen.getTime() : null,
      lastSeen: r.lastSeen ? r.lastSeen.getTime() : null
    })
  }
  return map
}

function readContacts(): EnrichContact[] {
  return getDb()
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      emails: contacts.emails,
      phones: contacts.phones
    })
    .from(contacts)
    .all()
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      emails: parseValues(r.emails),
      phones: parseValues(r.phones)
    }))
}

/**
 * CHEAP tier: match every contact to its derived person entity by normalized name
 * and persist the cross-source summary. No FTS, no network. Never throws (safe for
 * the post-sync hook). Returns how many contacts had their summary updated.
 */
export function enrichContactsFromCache(): number {
  try {
    const entities = readPersonEntities()
    const rows = readContacts()
    const now = Date.now()
    let written = 0
    for (const c of rows) {
      const entity = entities.get(normalizeName(c.displayName)) ?? null
      if (!entity) continue // nothing to say → don't write an empty summary
      const summary = computeCrossSourceSummary(entity, [], now)
      if (!isEmptySummary(summary) && writeContactEnrichment(c.id, summary)) written++
    }
    return written
  } catch (err) {
    console.warn('[contact-enrich] cache enrich failed (non-fatal):', err)
    return 0
  }
}

/** Deep-enrich a single contact (name-key entity + per-email FTS). Returns true if written. */
function enrichContactDeep(
  c: EnrichContact,
  entities: Map<string, EnrichmentPersonEntity>,
  sqlite: ReturnType<typeof getRawSqlite>,
  now: number
): boolean {
  const entity = entities.get(normalizeName(c.displayName)) ?? null
  const hits: EnrichmentRecordHit[] = []
  for (const e of c.emails.slice(0, MAX_EMAIL_QUERIES)) {
    if (!e.value?.trim()) continue
    for (const h of searchRecords(sqlite, { q: e.value, limit: HITS_PER_QUERY })) {
      hits.push({
        recordId: h.id,
        source: h.source,
        type: h.type,
        title: h.title,
        occurredAt: h.occurredAt,
        matchedVia: 'email'
      })
    }
  }
  if (!entity && hits.length === 0) return false // no signal at all
  const summary = computeCrossSourceSummary(entity, hits, now)
  return !isEmptySummary(summary) && writeContactEnrichment(c.id, summary)
}

/**
 * DEEP tier: the cheap name-match PLUS a per-contact FTS search over the `records`
 * timeline by each email address (high-specificity — the full address tokenizes to
 * a phrase, avoiding first-name false positives). Catches email-only touchpoints
 * the name key misses and fills `lastActivity`. Bounded per contact.
 */
export function enrichAllContactsDeep(): number {
  const sqlite = getRawSqlite()
  const entities = readPersonEntities()
  const rows = readContacts()
  const now = Date.now()
  let written = 0
  for (const c of rows) {
    if (enrichContactDeep(c, entities, sqlite, now)) written++
  }
  return written
}

function readOneContact(id: number): EnrichContact | null {
  const r = getDb()
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      emails: contacts.emails,
      phones: contacts.phones
    })
    .from(contacts)
    .where(eq(contacts.id, id))
    .all()[0]
  if (!r) return null
  return {
    id: r.id,
    displayName: r.displayName,
    emails: parseValues(r.emails),
    phones: parseValues(r.phones)
  }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const NOISE_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounce)/i

/** Does the email's local-part plausibly belong to this person (avoid attaching a stray address)? */
function emailMatchesName(email: string, displayName: string): boolean {
  const local = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z]/g, '')
  if (!local) return false
  const parts = displayName
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.replace(/[^a-z]/g, ''))
    .filter((p) => p.length >= 2)
  return parts.some((p) => local.includes(p))
}

/**
 * Best-effort identifier backfill for a name-only promoted contact: scan the records
 * they appear in and keep only email addresses whose local-part matches their name
 * (so a random mailing-list address isn't attached). Phones are intentionally skipped
 * (digit fragments false-positive against order/confirmation numbers).
 */
function backfillIdentifiersFromTimeline(c: EnrichContact): void {
  if (c.emails.length > 0 || !c.displayName.trim()) return // don't fight curated data
  const sqlite = getRawSqlite()
  const found = new Set<string>()
  for (const h of searchRecords(sqlite, { q: c.displayName, limit: 40 })) {
    const hay = `${h.title}\n${h.body ?? ''}`
    for (const m of hay.match(EMAIL_RE) ?? []) {
      const v = m.toLowerCase()
      if (
        found.has(v) ||
        NOISE_LOCAL.test(v.split('@')[0]) ||
        !emailMatchesName(v, c.displayName)
      ) {
        continue
      }
      found.add(v)
    }
  }
  if (found.size > 0) {
    addContactIdentifiers(c.id, { emails: [...found].map((value) => ({ value })) })
  }
}

/**
 * Rich-enrich ONE contact right after it's promoted from the People directory:
 * backfill any email we can find in their timeline, then compute + persist the
 * cross-source summary so the new contact immediately shows "Seen across N sources"
 * + activity instead of a bare name. Never throws.
 */
export function enrichOneContactDeep(contactId: number): void {
  try {
    let c = readOneContact(contactId)
    if (!c) return
    backfillIdentifiersFromTimeline(c)
    c = readOneContact(contactId) ?? c // re-read so the deep pass searches any found emails
    enrichContactDeep(c, readPersonEntities(), getRawSqlite(), Date.now())
  } catch (err) {
    console.warn('[contact-enrich] enrichOneContactDeep failed (non-fatal):', err)
  }
}

/**
 * Download the primary Google photo (a public googleusercontent URL captured into
 * `enrichment.google.photoUrl`) and inline it into `contacts.photo` as a data URI,
 * so the contact photo works offline and never phones home to Google at render
 * time. Idempotent + bounded: skips contacts that already have a stored photo, so
 * the cheap auto pass never triggers a re-download storm. Returns how many were
 * materialized.
 */
export async function materializeGooglePhotos(fetchImpl: typeof fetch = fetch): Promise<number> {
  const db = getDb()
  const rows = db
    .select({ id: contacts.id, photo: contacts.photo, enrichment: contacts.enrichment })
    .from(contacts)
    .all()
  let done = 0
  for (const r of rows) {
    if (done >= MAX_PHOTO_FETCHES) break
    if (r.photo) continue // already materialized
    const url = parseEnrichment(r.enrichment).google?.photoUrl
    if (!url || !isAllowedPhotoUrl(url)) continue // https + googleusercontent only (SSRF guard)
    try {
      const resp = await fetchImpl(url)
      if (!resp.ok) continue
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) continue
      const mime = resp.headers.get('content-type') || 'image/jpeg'
      if (!mime.startsWith('image/')) continue
      db.update(contacts)
        .set({ photo: `data:${mime};base64,${buf.toString('base64')}`, updatedAt: new Date() })
        .where(eq(contacts.id, r.id))
        .run()
      done++
    } catch {
      // one bad photo shouldn't stop the batch
    }
  }
  return done
}

/**
 * The live "recent activity" feed for a contact — an FTS search of the `records`
 * timeline by the contact's name + emails, deduped by record and newest-first.
 * Display-only (the persisted `crossSource` summary carries the counts).
 */
export function computeContactActivity(id: number, limit = 20): ContactActivityHit[] {
  const db = getDb()
  const c = db
    .select({ displayName: contacts.displayName, emails: contacts.emails })
    .from(contacts)
    .where(eq(contacts.id, id))
    .all()[0]
  if (!c) return []
  const sqlite = getRawSqlite()
  const byId = new Map<number, ContactActivityHit>()
  const push = (h: TimelineSearchHit): void => {
    if (!byId.has(h.id)) {
      byId.set(h.id, {
        recordId: h.id,
        source: h.source,
        type: h.type,
        title: h.title,
        occurredAt: h.occurredAt
      })
    }
  }
  if (c.displayName.trim()) {
    for (const h of searchRecords(sqlite, { q: c.displayName, limit: 30 })) push(h)
  }
  for (const e of parseValues(c.emails).slice(0, MAX_EMAIL_QUERIES)) {
    for (const h of searchRecords(sqlite, { q: e.value, limit: 30 })) push(h)
  }
  return [...byId.values()]
    .sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))
    .slice(0, limit)
}

export interface EnrichAllResult {
  success: boolean
  /** Net-new contacts added this run (Google saved connections + Other Contacts). */
  imported: number
  /** Existing contacts whose cross-source summary changed. */
  enriched: number
  photos: number
  /** Google is connected but a contacts scope isn't granted → prompt a reconnect. */
  needsReconnect: boolean
  error?: string
}

/** Total contacts, for a before/after import delta. */
function countContacts(): number {
  try {
    const row = getRawSqlite().prepare('SELECT COUNT(*) AS n FROM contacts').get() as {
      n: number
    }
    return row?.n ?? 0
  } catch {
    return 0
  }
}

/**
 * True when Google is connected but hasn't granted a contacts scope — the signal
 * to prompt a reconnect (a token refresh never widens scopes). `contacts.other.readonly`
 * is the one added after most users first connected, so it's the usual trigger.
 */
export function googleNeedsContactsReconnect(): boolean {
  try {
    if (!loadToken('google')) return false // not connected → nothing to reconnect
    return !hasGoogleScope('contacts.readonly') || !hasGoogleScope('contacts.other.readonly')
  } catch {
    return false
  }
}

/**
 * The "Enrich all" orchestration: pull the latest Google contacts — saved
 * connections AND the Other Contacts address book (when scoped) — reproject the
 * spine, materialize photos, then deep cross-source enrich. Reports how many
 * contacts were newly imported and whether a Google reconnect is needed to unlock
 * the full address book. `syncGoogle` is imported lazily to avoid a static import
 * cycle (sync → storehouse-sync → contact-enrich).
 */
export async function runEnrichAll(win?: BrowserWindow | null): Promise<EnrichAllResult> {
  const before = countContacts()
  try {
    const { syncGoogle, maybeSendNotification } = await import('./sync')
    const google = await syncGoogle(win)
    if (!google.success) {
      // Not connected / Google failed — still refresh the derived cache over
      // whatever local sources exist so the deep pass has something to match.
      try {
        const { refreshDerivedEntities } = await import('../lib/entities-projection')
        refreshDerivedEntities(getDb())
      } catch {
        // best-effort
      }
    }
    let photos = 0
    try {
      photos = await materializeGooglePhotos()
    } catch {
      // photos are a bonus — never fail the run
    }
    const enriched = enrichAllContactsDeep()
    const imported = Math.max(0, countContacts() - before)
    const needsReconnect = googleNeedsContactsReconnect()
    win?.webContents.send('sync:update', {
      service: 'contacts',
      status: 'success',
      recordsUpdated: imported + enriched
    })
    maybeSendNotification('contacts', imported + enriched)
    return { success: true, imported, enriched, photos, needsReconnect }
  } catch (err) {
    const message = (err as Error).message
    win?.webContents.send('sync:update', { service: 'contacts', status: 'error', error: message })
    return {
      success: false,
      imported: Math.max(0, countContacts() - before),
      enriched: 0,
      photos: 0,
      needsReconnect: googleNeedsContactsReconnect(),
      error: message
    }
  }
}

export function registerContactEnrichHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('contacts:enrich-all', (): Promise<EnrichAllResult> => {
    const win = BrowserWindow.getAllWindows()[0] ?? null
    return runEnrichAll(win)
  })

  ipcMain.handle('contacts:activity', (_event, id: number): ContactActivityHit[] => {
    if (!Number.isInteger(id)) throw new Error('contacts:activity requires an integer id')
    return computeContactActivity(id)
  })

  // Cheap read so the Contacts page can proactively show the reconnect prompt on load.
  ipcMain.handle('contacts:enrich-status', (): { needsReconnect: boolean } => ({
    needsReconnect: googleNeedsContactsReconnect()
  }))
}
