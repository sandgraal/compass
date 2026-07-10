import type { ContactInput } from '../ipc/contacts'
/**
 * Google Contacts (People API) sync — the first LIVE address-book source, now
 * enriched to pull everything Google knows about each saved contact.
 *
 * The Contacts page was manual-import-only; this pulls the user's Google
 * connections into the owned `contacts` table via the same upsert path a vCard
 * import uses (`upsertContacts`, keyed on `externalId` = the People API
 * `resourceName`, `source:'google'`), so re-syncing updates in place.
 *
 * We request a WIDE `personFields` mask so the rich fields land somewhere:
 *   - Fields with a dedicated column (names incl. middle/prefix/suffix,
 *     addresses, birthday, primary url, primary org/title) fill those columns.
 *   - Everything else (nicknames, biography, all urls, IM handles, relations,
 *     important dates, occupations, extra orgs, contact-group labels, the
 *     primary photo URL) lands in `enrichment.google` (see contact-enrichment.ts).
 *
 * Requires only the `contacts.readonly` OAuth scope — it already authorizes every
 * `personField` on `people/me/connections` AND `contactGroups.list`; NO new scope
 * or reconnect is needed to widen the pull. Because that scope was added after the
 * original Google connection, an already-connected user must RECONNECT Google to
 * grant it at all; until then the People API returns 403 and the caller treats
 * contacts as a soft-skip so the rest of the Google sync still succeeds.
 *
 * Photo BYTES are deliberately NOT downloaded here (only the URL is captured into
 * `enrichment.google.photoUrl`) so the 15-min cron never re-downloads every
 * avatar; the on-demand "Enrich all" deep pass materializes them into
 * `contacts.photo` as data URIs (see electron/ipc/contact-enrich.ts).
 *
 * `googlePersonToContact` (pure) and the network fetchers (`fetch` injected) are
 * the testable units; the DB upsert happens in the caller.
 */
import type { GoogleEnrichment } from '../lib/contact-enrichment'
import type { ContactAddress } from '../lib/vcard'

/** The subset of a People API `person` resource we map. */
export interface GooglePerson {
  resourceName?: string
  names?: Array<{
    displayName?: string
    givenName?: string
    familyName?: string
    middleName?: string
    honorificPrefix?: string
    honorificSuffix?: string
    phoneticFullName?: string
  }>
  emailAddresses?: Array<{ value?: string; type?: string }>
  phoneNumbers?: Array<{ value?: string; type?: string }>
  organizations?: Array<{ name?: string; title?: string }>
  addresses?: Array<{
    formattedValue?: string
    streetAddress?: string
    extendedAddress?: string
    city?: string
    region?: string
    postalCode?: string
    country?: string
    type?: string
  }>
  birthdays?: Array<{ date?: { year?: number; month?: number; day?: number }; text?: string }>
  photos?: Array<{ url?: string; default?: boolean }>
  urls?: Array<{ value?: string; type?: string }>
  biographies?: Array<{ value?: string; contentType?: string }>
  nicknames?: Array<{ value?: string; type?: string }>
  occupations?: Array<{ value?: string }>
  relations?: Array<{ person?: string; type?: string }>
  events?: Array<{ date?: { year?: number; month?: number; day?: number }; type?: string }>
  imClients?: Array<{ username?: string; protocol?: string; type?: string }>
  userDefined?: Array<{ key?: string; value?: string }>
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string } }>
  metadata?: { sources?: Array<{ updateTime?: string }> }
}

interface ConnectionsResponse {
  connections?: GooglePerson[]
  nextPageToken?: string
}

interface ContactGroup {
  resourceName?: string
  name?: string
  formattedName?: string
  groupType?: string
}

interface ContactGroupsResponse {
  contactGroups?: ContactGroup[]
  nextPageToken?: string
}

/** Raised when the token lacks `contacts.readonly` — the caller soft-skips. */
export class ContactsScopeError extends Error {
  constructor() {
    super('Google contacts scope not granted — reconnect Google to sync contacts.')
    this.name = 'ContactsScopeError'
  }
}

// The wide mask. `contacts.readonly` authorizes all of these on your own
// connections — no extra scope. Kept in sync with the fields mapped below.
const PERSON_FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'addresses',
  'birthdays',
  'photos',
  'urls',
  'biographies',
  'nicknames',
  'occupations',
  'relations',
  'events',
  'imClients',
  'userDefined',
  'memberships',
  'metadata'
].join(',')
const PAGE_SIZE = 1000
const MAX_PAGES = 25 // safety bound: 25k connections; avoids an unbounded loop
// The two ubiquitous system groups every contact belongs to — not informative
// as a label, so they're dropped from `googleLabels`.
const NOISE_GROUPS = new Set(['contactGroups/myContacts', 'contactGroups/all'])

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Compose a People `date` into ISO `YYYY-MM-DD`, or year-less `--MM-DD`. */
function composeDate(
  date: { year?: number; month?: number; day?: number } | undefined,
  fallbackText?: string
): string | null {
  if (date?.month && date?.day) {
    const mm = pad2(date.month)
    const dd = pad2(date.day)
    return date.year ? `${date.year}-${mm}-${dd}` : `--${mm}-${dd}`
  }
  return fallbackText?.trim() || null
}

/** Latest source `updateTime` across a person's metadata, as epoch ms. */
function latestUpdateMs(p: GooglePerson): number | null {
  let max: number | null = null
  for (const s of p.metadata?.sources ?? []) {
    if (!s.updateTime) continue
    const t = Date.parse(s.updateTime)
    if (!Number.isNaN(t) && (max === null || t > max)) max = t
  }
  return max
}

/**
 * Build the `enrichment.google` block from the rich People fields that have no
 * dedicated column. `groupNames` resolves membership resource names → labels.
 * Returns undefined when nothing rich is present (so we never write an empty
 * `{ google: {} }`).
 */
function buildGoogleEnrichment(
  p: GooglePerson,
  groupNames?: Map<string, string>
): GoogleEnrichment | undefined {
  const g: GoogleEnrichment = {}

  const nicknames = (p.nicknames ?? []).map((n) => n.value?.trim()).filter((v): v is string => !!v)
  if (nicknames.length) g.nicknames = nicknames

  const biography = p.biographies?.find((b) => b.value?.trim())?.value?.trim()
  if (biography) g.biography = biography

  const urls = (p.urls ?? [])
    .filter((u) => u.value?.trim())
    .map((u) => ({ type: u.type || undefined, value: u.value as string }))
  if (urls.length) g.urls = urls

  const imHandles = (p.imClients ?? [])
    .filter((im) => im.username?.trim())
    .map((im) => ({ protocol: im.protocol || undefined, username: im.username as string }))
  if (imHandles.length) g.imHandles = imHandles

  const relations = (p.relations ?? [])
    .filter((r) => r.person?.trim())
    .map((r) => ({ person: r.person as string, type: r.type || undefined }))
  if (relations.length) g.relations = relations

  const importantDates = (p.events ?? [])
    .map((e) => ({ type: e.type || undefined, date: composeDate(e.date) }))
    .filter((e): e is { type: string | undefined; date: string } => !!e.date)
  if (importantDates.length) g.importantDates = importantDates

  const occupations = (p.occupations ?? [])
    .map((o) => o.value?.trim())
    .filter((v): v is string => !!v)
  if (occupations.length) g.occupations = occupations

  // Organizations beyond the first (the first fills the org/jobTitle columns).
  const extraOrgs = (p.organizations ?? [])
    .slice(1)
    .filter((o) => o.name?.trim() || o.title?.trim())
    .map((o) => ({ name: o.name || undefined, title: o.title || undefined }))
  if (extraOrgs.length) g.organizations = extraOrgs

  const userDefined = (p.userDefined ?? [])
    .filter((u) => u.key?.trim() && u.value?.trim())
    .map((u) => ({ key: u.key as string, value: u.value as string }))
  if (userDefined.length) g.userDefined = userDefined

  if (groupNames) {
    const labels: string[] = []
    for (const m of p.memberships ?? []) {
      const rn = m.contactGroupMembership?.contactGroupResourceName
      if (!rn || NOISE_GROUPS.has(rn)) continue
      const label = groupNames.get(rn)
      if (label) labels.push(label)
    }
    if (labels.length) g.googleLabels = labels
  }

  const phoneticName = p.names?.[0]?.phoneticFullName?.trim()
  if (phoneticName) g.phoneticName = phoneticName

  const updatedAt = latestUpdateMs(p)
  if (updatedAt !== null) g.updatedAt = updatedAt

  const photoUrl = p.photos?.find((ph) => ph.url && !ph.default)?.url
  if (photoUrl) g.photoUrl = photoUrl

  return Object.keys(g).length > 0 ? g : undefined
}

/**
 * Map one People API person → a ContactInput, or null when it carries no usable
 * name (a bare phone-only connection isn't worth an address-book row). Pure:
 * `groupNames` (resource name → label) is passed in by the caller.
 *
 * Note: `photo` is intentionally NOT set here — only `enrichment.google.photoUrl`
 * — so a plain sync never overwrites an already-materialized `contacts.photo`
 * data URI. Byte materialization happens in the deep enrich pass.
 */
export function googlePersonToContact(
  p: GooglePerson,
  groupNames?: Map<string, string>
): ContactInput | null {
  const name = p.names?.[0]
  const org = p.organizations?.[0]
  const emails = (p.emailAddresses ?? [])
    .filter((e) => e.value)
    .map((e) => ({ type: e.type || 'other', value: e.value as string }))
  const phones = (p.phoneNumbers ?? [])
    .filter((ph) => ph.value)
    .map((ph) => ({ type: ph.type || 'other', value: ph.value as string }))

  const displayName = name?.displayName?.trim() || emails[0]?.value || ''
  if (!displayName) return null // no name and no email → nothing to show

  const addresses: ContactAddress[] = (p.addresses ?? [])
    .map((a) => ({
      type: a.type || undefined,
      street: a.streetAddress?.trim() || a.formattedValue?.trim() || undefined,
      city: a.city || undefined,
      region: a.region || undefined,
      postalCode: a.postalCode || undefined,
      country: a.country || undefined
    }))
    .filter((a) => a.street || a.city || a.region || a.postalCode || a.country)

  const birthday = p.birthdays?.[0] ? composeDate(p.birthdays[0].date, p.birthdays[0].text) : null
  const url = p.urls?.find((u) => u.value?.trim())?.value?.trim() ?? null
  const enrichment = buildGoogleEnrichment(p, groupNames)

  return {
    externalId: p.resourceName || undefined, // upsertContacts mints a uuid if absent
    displayName,
    givenName: name?.givenName ?? null,
    familyName: name?.familyName ?? null,
    middleName: name?.middleName ?? null,
    prefix: name?.honorificPrefix ?? null,
    suffix: name?.honorificSuffix ?? null,
    org: org?.name ?? null,
    jobTitle: org?.title ?? null,
    emails,
    phones,
    addresses: addresses.length ? addresses : undefined,
    birthday,
    url,
    source: 'google',
    ...(enrichment ? { enrichment: { google: enrichment } } : {})
  }
}

/**
 * Page through `people/me/connections`, accumulating every connection. `fetchImpl`
 * is injected for tests. Throws `ContactsScopeError` on a 403 (missing scope) and a
 * generic Error on any other non-OK response.
 */
export async function fetchGoogleConnections(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<GooglePerson[]> {
  const headers = { Authorization: `Bearer ${accessToken}` }
  const people: GooglePerson[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections')
    url.searchParams.set('personFields', PERSON_FIELDS)
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const resp = await fetchImpl(url.toString(), { headers })
    if (resp.status === 403) throw new ContactsScopeError()
    if (!resp.ok) throw new Error(`People API ${resp.status}`)
    const data = (await resp.json()) as ConnectionsResponse
    if (data.connections) people.push(...data.connections)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return people
}

/**
 * Fetch the user's contact groups → a `resourceName → label` map used to resolve
 * each person's memberships into human labels. Best-effort: any failure (incl. a
 * missing scope) yields an empty map so labels are simply absent, never fatal.
 */
export async function fetchContactGroups(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const headers = { Authorization: `Bearer ${accessToken}` }
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://people.googleapis.com/v1/contactGroups')
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const resp = await fetchImpl(url.toString(), { headers })
      if (!resp.ok) break
      const data = (await resp.json()) as ContactGroupsResponse
      for (const grp of data.contactGroups ?? []) {
        const rn = grp.resourceName
        const label = grp.formattedName?.trim() || grp.name?.trim()
        if (rn && label && !NOISE_GROUPS.has(rn)) map.set(rn, label)
      }
      if (!data.nextPageToken) break
      pageToken = data.nextPageToken
    }
  } catch {
    // best-effort — labels are enrichment, not load-bearing
  }
  return map
}

/**
 * Fetch + map every Google connection into ContactInput rows ready for
 * `upsertContacts`, resolving contact-group labels. Kept separate from the DB
 * write so this stays pure of the `getDb()` singleton and easy to test.
 */
export async function buildGoogleContactInputs(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ContactInput[]> {
  const [people, groupNames] = await Promise.all([
    fetchGoogleConnections(accessToken, fetchImpl),
    fetchContactGroups(accessToken, fetchImpl)
  ])
  return people
    .map((p) => googlePersonToContact(p, groupNames))
    .filter((c): c is ContactInput => c !== null)
}

// "Other contacts" — everyone the user has emailed, auto-saved by Google. This is
// where the bulk of a real address book lives. The API RESTRICTS the readMask to
// these four fields (the wide `PERSON_FIELDS` mask 400s here), and many rows are
// email-only with no name.
const OTHER_CONTACT_FIELDS = 'names,emailAddresses,phoneNumbers,metadata'
const MAX_OTHER_PAGES = 100 // up to 100k; sets `truncated` if it caps out

interface OtherContactsResponse {
  otherContacts?: GooglePerson[]
  nextPageToken?: string
}

/**
 * Page through `otherContacts.list`. Requires the `contacts.other.readonly` scope.
 * On any non-OK response it throws an Error carrying the HTTP status AND Google's
 * error body (e.g. "insufficient scopes" / "API not enabled") — the block is
 * already scope-gated, so a failure here is a config/permission issue we want to
 * SURFACE, not silently swallow. Returns the raw people + a `truncated` flag.
 */
export async function fetchGoogleOtherContacts(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ people: GooglePerson[]; truncated: boolean }> {
  const headers = { Authorization: `Bearer ${accessToken}` }
  const people: GooglePerson[] = []
  let pageToken: string | undefined
  let truncated = false
  for (let page = 0; page < MAX_OTHER_PAGES; page++) {
    const url = new URL('https://people.googleapis.com/v1/otherContacts')
    url.searchParams.set('readMask', OTHER_CONTACT_FIELDS)
    // Explicit — the auto-saved "Other contacts" are CONTACT-source.
    url.searchParams.set('sources', 'READ_SOURCE_TYPE_CONTACT')
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const resp = await fetchImpl(url.toString(), { headers })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(
        `otherContacts ${resp.status}: ${extractApiError(body) || body.slice(0, 200)}`
      )
    }
    const data = (await resp.json()) as OtherContactsResponse
    if (data.otherContacts) people.push(...data.otherContacts)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
    if (page === MAX_OTHER_PAGES - 1) truncated = true
  }
  return { people, truncated }
}

/** Pull the human-readable `error.message` out of a Google API JSON error body. */
function extractApiError(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string } }
    if (j.error?.message) return `${j.error.status ?? ''} ${j.error.message}`.trim()
  } catch {
    /* not JSON */
  }
  return null
}

/**
 * Fetch + map every "other contact" into ContactInput rows tagged
 * `source:'google-other'` (so they stay separable/bulk-removable from the curated
 * connections). Name-less, email-only rows map fine — `googlePersonToContact`
 * falls back to the email as the display name. `fetched` is the RAW row count
 * Google returned (before mapping/dropping), so the caller can distinguish
 * "API returned nothing" from "returned rows but all were dropped".
 */
export async function buildGoogleOtherContactInputs(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ inputs: ContactInput[]; truncated: boolean; fetched: number }> {
  const { people, truncated } = await fetchGoogleOtherContacts(accessToken, fetchImpl)
  const inputs = people
    .map((p) => googlePersonToContact(p))
    .filter((c): c is ContactInput => c !== null)
    .map((c) => ({ ...c, source: 'google-other' }))
  return { inputs, truncated, fetched: people.length }
}
