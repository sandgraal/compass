/**
 * Google Contacts (People API) sync — the first LIVE address-book source.
 *
 * The Contacts page was manual-import-only; this pulls the user's Google
 * connections into the owned `contacts` table via the same upsert path a vCard
 * import uses (`upsertContacts`, keyed on `externalId` = the People API
 * `resourceName`, `source:'google'`), so re-syncing updates in place.
 *
 * Requires the `contacts.readonly` OAuth scope. Because that scope was added after
 * the original Google connection, an already-connected user must RECONNECT Google
 * to grant it; until then the People API returns 403 and the caller treats contacts
 * as a soft-skip so the rest of the Google sync still succeeds.
 *
 * `googlePersonToContact` (pure) and `fetchGoogleConnections` (network, `fetch`
 * injected) are the testable units; the DB upsert happens in the caller.
 */
import type { ContactInput } from '../ipc/contacts'

/** The subset of a People API `person` resource we map. */
export interface GooglePerson {
  resourceName?: string
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>
  emailAddresses?: Array<{ value?: string; type?: string }>
  phoneNumbers?: Array<{ value?: string; type?: string }>
  organizations?: Array<{ name?: string; title?: string }>
}

interface ConnectionsResponse {
  connections?: GooglePerson[]
  nextPageToken?: string
}

/** Raised when the token lacks `contacts.readonly` — the caller soft-skips. */
export class ContactsScopeError extends Error {
  constructor() {
    super('Google contacts scope not granted — reconnect Google to sync contacts.')
    this.name = 'ContactsScopeError'
  }
}

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations'
const PAGE_SIZE = 1000
const MAX_PAGES = 25 // safety bound: 25k connections; avoids an unbounded loop

/**
 * Map one People API person → a ContactInput, or null when it carries no usable
 * name (a bare phone-only connection isn't worth an address-book row).
 */
export function googlePersonToContact(p: GooglePerson): ContactInput | null {
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

  return {
    externalId: p.resourceName || undefined, // upsertContacts mints a uuid if absent
    displayName,
    givenName: name?.givenName ?? null,
    familyName: name?.familyName ?? null,
    org: org?.name ?? null,
    jobTitle: org?.title ?? null,
    emails,
    phones,
    source: 'google'
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
 * Fetch + map every Google connection into ContactInput rows ready for
 * `upsertContacts`. Kept separate from the DB write so this stays pure of the
 * `getDb()` singleton and easy to test.
 */
export async function buildGoogleContactInputs(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ContactInput[]> {
  const people = await fetchGoogleConnections(accessToken, fetchImpl)
  return people.map(googlePersonToContact).filter((c): c is ContactInput => c !== null)
}
