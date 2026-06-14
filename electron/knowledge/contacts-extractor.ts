/**
 * Contacts → markdown writer (Phase 9 — "The Storehouse", Wave 1).
 *
 * Mirrors `finance-extractor.ts`: after any contacts mutation we regenerate
 * `profile/relationships.md` so the human-readable knowledge base (and the LLM
 * context window / Ask Compass) stays in sync with the structured `contacts`
 * table. Before this, that file was hand-maintained; now it's derived.
 *
 * Only non-secret address-book fields are written here — exactly what you'd put
 * on a holiday-card list. Nothing from the encrypted Vault touches this file.
 */

import { KNOWLEDGE_DIR } from '../paths'
import { updateKnowledgeFile } from './writer'

export interface ContactLike {
  displayName: string
  org?: string | null
  jobTitle?: string | null
  relationship?: string | null
  birthday?: string | null
  notes?: string | null
  phones?: Array<{ type?: string; value: string }>
  emails?: Array<{ type?: string; value: string }>
  addresses?: Array<{
    street?: string
    city?: string
    region?: string
    postalCode?: string
    country?: string
  }>
}

// Stable display order for the relationship buckets; anything else falls into
// "Other". Keys are matched case-insensitively against `contact.relationship`.
const GROUP_ORDER = ['family', 'friend', 'colleague', 'work', 'other'] as const

function groupKey(relationship: string | null | undefined): string {
  const r = (relationship ?? '').trim().toLowerCase()
  if (!r) return 'other'
  if (r.includes('famil')) return 'family'
  if (r.includes('friend')) return 'friend'
  if (r.includes('colleague') || r.includes('coworker') || r.includes('co-worker'))
    return 'colleague'
  if (r.includes('work') || r.includes('business')) return 'work'
  return 'other'
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function oneLine(c: ContactLike): string {
  const bits: string[] = [`**${c.displayName}**`]
  const role = [c.jobTitle, c.org].filter(Boolean).join(', ')
  if (role) bits.push(role)
  const phone = c.phones?.find((p) => p.value)?.value
  if (phone) bits.push(phone)
  const email = c.emails?.find((e) => e.value)?.value
  if (email) bits.push(email)
  const city = c.addresses?.find((a) => a.city)?.city
  if (city) bits.push(city)
  if (c.birthday) bits.push(`🎂 ${c.birthday}`)
  return `- ${bits.join(' · ')}`
}

/** Build the `profile/relationships.md` content from the full contact list. */
export function buildRelationshipsMarkdown(contacts: ContactLike[], stamp: string): string {
  const lines: string[] = [
    '# People & Relationships',
    '',
    `> Auto-updated by Compass — ${stamp}.`,
    '> Edit people in the **Contacts** page; this file is generated from there.',
    '> Full records (every phone, email, address) live in the Contacts database.',
    ''
  ]

  if (contacts.length === 0) {
    lines.push('_No contacts yet. Import a vCard or add someone in the Contacts page._', '')
    return `${lines.join('\n')}\n`
  }

  const buckets = new Map<string, ContactLike[]>()
  for (const c of contacts) {
    const key = groupKey(c.relationship)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)?.push(c)
  }

  lines.push(`**${contacts.length}** contact${contacts.length === 1 ? '' : 's'} on file.`, '')

  for (const group of GROUP_ORDER) {
    const members = buckets.get(group)
    if (!members || members.length === 0) continue
    const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName))
    lines.push(`## ${titleCase(group)}`, '')
    for (const c of sorted) lines.push(oneLine(c))
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

/** Regenerate `profile/relationships.md` from the contact list. Best-effort. */
export function writeRelationships(contacts: ContactLike[]): void {
  const stamp = new Date().toLocaleString()
  updateKnowledgeFile(
    KNOWLEDGE_DIR,
    'profile/relationships.md',
    buildRelationshipsMarkdown(contacts, stamp)
  )
}
