/**
 * vCard codec (Phase 9 — "The Storehouse", Wave 1).
 *
 * Hand-rolled parse + serialize for vCard 3.0 and 4.0 — the format you get when
 * you export contacts from a phone, Google Contacts, or iCloud, and the format
 * you import into a new service. No third-party dependency: the grammar is the
 * same CRLF-folded `NAME;PARAMS:VALUE` shape the in-house ICS reader already
 * handles (`electron/integrations/apple-calendar.ts`), so we keep the
 * supply-chain surface at zero and the behaviour fully under test.
 *
 * Scope of this cut:
 *   - 3.0 + 4.0 input; 3.0 output by default (widest device compatibility).
 *   - FN, N, ORG, TITLE, TEL, EMAIL, ADR, BDAY (incl. 4.0 year-less --MM-DD),
 *     URL, NOTE, UID, PHOTO (base64 ↔ data URI), and X-RELATIONSHIP round-trip.
 *   - Group prefixes (`item1.TEL`), bare 2.1-style TYPE params, quoted params,
 *     comma-joined TYPE lists, and 75-octet line folding are all handled.
 */

import { randomUUID } from 'node:crypto'

export interface ContactPhone {
  type?: string
  value: string
  pref?: boolean
}

export interface ContactEmail {
  type?: string
  value: string
  pref?: boolean
}

export interface ContactAddress {
  type?: string
  street?: string
  city?: string
  region?: string
  postalCode?: string
  country?: string
  pref?: boolean
}

export interface ParsedContact {
  externalId: string
  displayName: string
  givenName?: string
  familyName?: string
  middleName?: string
  prefix?: string
  suffix?: string
  org?: string
  jobTitle?: string
  phones: ContactPhone[]
  emails: ContactEmail[]
  addresses: ContactAddress[]
  birthday?: string
  url?: string
  relationship?: string
  notes?: string
  photo?: string
}

// ─── Low-level text helpers ──────────────────────────────────────────────────

/** Unfold RFC 6350 line continuations: a line starting with SPACE/TAB joins the previous. */
function unfold(raw: string): string[] {
  const out: string[] = []
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  for (const line of lines) {
    if (out.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

/** Decode vCard TEXT escapes (`\n`, `\,`, `\;`, `\\`) in a single pass. */
function unescapeText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === 'n' || n === 'N') out += '\n'
      else if (n === ',') out += ','
      else if (n === ';') out += ';'
      else if (n === '\\') out += '\\'
      else out += n
      i++
    } else {
      out += s[i]
    }
  }
  return out
}

/** Escape a TEXT value for output (backslash first, then the structural chars). */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

/** Split a structured value on an unescaped separator, then unescape each part. */
function splitStructured(value: string, sep: ';' | ','): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      cur += value[i] + value[i + 1]
      i++
    } else if (value[i] === sep) {
      parts.push(cur)
      cur = ''
    } else {
      cur += value[i]
    }
  }
  parts.push(cur)
  return parts.map(unescapeText)
}

type VCardProp = { name: string; params: Record<string, string[]>; value: string }

/** Parse one content line into `{ name, params, value }`, stripping group prefixes. */
function splitLine(line: string): VCardProp | null {
  // First unquoted colon separates the property part from the value.
  let inQuotes = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ':' && !inQuotes) {
      colon = i
      break
    }
  }
  if (colon === -1) return null
  let lhs = line.slice(0, colon)
  const value = line.slice(colon + 1)

  // Strip a group prefix like `item1.TEL` → `TEL` (only when the dot precedes
  // any param `;`, so a dot inside a param value is left alone).
  const dot = lhs.indexOf('.')
  if (dot !== -1) {
    const semi = lhs.indexOf(';')
    if (semi === -1 || dot < semi) lhs = lhs.slice(dot + 1)
  }

  const segs = lhs.split(';')
  const name = (segs.shift() ?? '').toUpperCase()
  if (!name) return null
  const params: Record<string, string[]> = {}
  for (const seg of segs) {
    const eq = seg.indexOf('=')
    if (eq === -1) {
      // Bare param (vCard 2.1): `;HOME`, `;CELL`, `;PREF` → treat as a TYPE.
      const v = seg.trim().toLowerCase()
      if (v) {
        params.TYPE ??= []
        params.TYPE.push(v)
      }
      continue
    }
    const key = seg.slice(0, eq).toUpperCase()
    const rawVal = seg.slice(eq + 1).replace(/^"|"$/g, '')
    for (const v of rawVal.split(',')) {
      const t = v.trim().toLowerCase()
      if (t) {
        params[key] ??= []
        params[key].push(t)
      }
    }
  }
  return { name, params, value }
}

function typesOf(prop: VCardProp): { types: string[]; pref: boolean } {
  const types = prop.params.TYPE ?? []
  const pref = types.includes('pref') || prop.params.PREF != null
  return { types, pref }
}

/** Pick the human-facing type label, dropping transport noise like `voice`/`internet`. */
function primaryType(types: string[], drop: string[]): string | undefined {
  const meaningful = types.filter((t) => t !== 'pref' && !drop.includes(t))
  return meaningful[0]
}

/** Normalize a BDAY value to `YYYY-MM-DD`, or `--MM-DD` when the year is absent (vCard 4.0). */
function normalizeBday(value: string): string {
  const datePart = value.trim().split('T')[0]
  let m = datePart.match(/^(\d{4})-?(\d{2})-?(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = datePart.match(/^--(\d{2})-?(\d{2})$/)
  if (m) return `--${m[1]}-${m[2]}`
  return datePart
}

// ─── Parse ───────────────────────────────────────────────────────────────────

/**
 * Parse a `.vcf` payload into zero or more contacts. Multi-VCARD files are
 * supported (one address book = many cards). A card with no `FN` falls back to
 * its `N` components or `ORG`; a card with no `UID` gets a freshly minted one so
 * the importer can dedupe on re-import.
 */
export function parseVCard(raw: string): ParsedContact[] {
  const lines = unfold(raw)
  const contacts: ParsedContact[] = []
  let current: ParsedContact | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toUpperCase() === 'BEGIN:VCARD') {
      current = {
        externalId: '',
        displayName: '',
        phones: [],
        emails: [],
        addresses: []
      }
      continue
    }
    if (trimmed.toUpperCase() === 'END:VCARD') {
      if (current) {
        if (!current.displayName) {
          const n = [current.givenName, current.familyName].filter(Boolean).join(' ').trim()
          current.displayName = n || current.org || 'Unnamed Contact'
        }
        if (!current.externalId) current.externalId = `urn:uuid:${randomUUID()}`
        contacts.push(current)
      }
      current = null
      continue
    }
    if (!current) continue

    const prop = splitLine(line)
    if (!prop) continue

    switch (prop.name) {
      case 'VERSION':
        break
      case 'UID':
        current.externalId = prop.value.trim()
        break
      case 'FN':
        current.displayName = unescapeText(prop.value).trim()
        break
      case 'N': {
        const [family, given, middle, prefix, suffix] = splitStructured(prop.value, ';')
        current.familyName = family || undefined
        current.givenName = given || undefined
        current.middleName = middle || undefined
        current.prefix = prefix || undefined
        current.suffix = suffix || undefined
        break
      }
      case 'ORG':
        current.org = splitStructured(prop.value, ';')[0]?.trim() || undefined
        break
      case 'TITLE':
        current.jobTitle = unescapeText(prop.value).trim() || undefined
        break
      case 'TEL': {
        const { types, pref } = typesOf(prop)
        current.phones.push({
          type: primaryType(types, ['voice', 'text', 'fax', 'video']),
          value: unescapeText(prop.value).trim(),
          ...(pref ? { pref: true } : {})
        })
        break
      }
      case 'EMAIL': {
        const { types, pref } = typesOf(prop)
        current.emails.push({
          type: primaryType(types, ['internet']),
          value: unescapeText(prop.value).trim(),
          ...(pref ? { pref: true } : {})
        })
        break
      }
      case 'ADR': {
        const { types, pref } = typesOf(prop)
        // ADR = pobox;ext;street;locality;region;postal;country
        const c = splitStructured(prop.value, ';')
        const addr: ContactAddress = {
          type: primaryType(types, []),
          street: c[2] || undefined,
          city: c[3] || undefined,
          region: c[4] || undefined,
          postalCode: c[5] || undefined,
          country: c[6] || undefined,
          ...(pref ? { pref: true } : {})
        }
        // Skip a wholly empty ADR (some exporters emit a bare `ADR:;;;;;;`).
        if (addr.street || addr.city || addr.region || addr.postalCode || addr.country) {
          current.addresses.push(addr)
        }
        break
      }
      case 'BDAY':
        current.birthday = normalizeBday(prop.value)
        break
      case 'URL':
        if (!current.url) current.url = prop.value.trim()
        break
      case 'NOTE':
        current.notes = unescapeText(prop.value)
        break
      case 'X-RELATIONSHIP':
      case 'X-ABRELATEDNAMES':
        if (!current.relationship)
          current.relationship = unescapeText(prop.value).trim() || undefined
        break
      case 'PHOTO': {
        // Match the base64 token exactly — vCard 3.0 uses `b`, MIME/4.0 uses
        // `base64`. A substring test would wrongly treat `8bit` as base64.
        const encs = prop.params.ENCODING ?? []
        if (encs.includes('b') || encs.includes('base64')) {
          const type = (prop.params.TYPE ?? ['jpeg'])[0] || 'jpeg'
          current.photo = `data:image/${type};base64,${prop.value.replace(/\s+/g, '')}`
        } else if (/^data:image\//i.test(prop.value) || /^https?:/i.test(prop.value)) {
          // Only accept image data URIs — never `data:text/html;…` etc.
          current.photo = prop.value.trim()
        }
        break
      }
    }
  }

  return contacts
}

// ─── Serialize ───────────────────────────────────────────────────────────────

/** Fold a content line at 75 octets per RFC 6350 §3.2 (continuation lines start with a space). */
function foldLine(line: string): string {
  const MAX = 75
  if (Buffer.byteLength(line, 'utf8') <= MAX) return line
  const segments: string[] = []
  let cur = ''
  let curBytes = 0
  let first = true
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    const limit = first ? MAX : MAX - 1 // continuation lines carry a leading space
    if (curBytes + chBytes > limit) {
      segments.push(cur)
      first = false
      cur = ch
      curBytes = chBytes
    } else {
      cur += ch
      curBytes += chBytes
    }
  }
  segments.push(cur)
  return segments.map((seg, i) => (i === 0 ? seg : ` ${seg}`)).join('\r\n')
}

function typeParam(type: string | undefined, pref: boolean | undefined, fallback: string): string {
  const types = [type || fallback]
  if (pref) types.push('pref')
  return types.join(',')
}

/**
 * Serialize contacts to a `.vcf` string. Defaults to vCard 3.0 output for the
 * widest device/service compatibility; pass `'4.0'` for the newer spec.
 */
export function serializeVCard(contacts: ParsedContact[], version: '3.0' | '4.0' = '3.0'): string {
  const blocks: string[] = []
  for (const c of contacts) {
    const lines: string[] = ['BEGIN:VCARD', `VERSION:${version}`]

    const fn = c.displayName || [c.givenName, c.familyName].filter(Boolean).join(' ').trim()
    lines.push(foldLine(`FN:${escapeText(fn || 'Unnamed Contact')}`))

    if (c.familyName || c.givenName || c.middleName || c.prefix || c.suffix) {
      lines.push(
        foldLine(
          `N:${escapeText(c.familyName ?? '')};${escapeText(c.givenName ?? '')};${escapeText(
            c.middleName ?? ''
          )};${escapeText(c.prefix ?? '')};${escapeText(c.suffix ?? '')}`
        )
      )
    }
    if (c.org) lines.push(foldLine(`ORG:${escapeText(c.org)}`))
    if (c.jobTitle) lines.push(foldLine(`TITLE:${escapeText(c.jobTitle)}`))

    for (const p of c.phones) {
      if (!p.value) continue
      lines.push(foldLine(`TEL;TYPE=${typeParam(p.type, p.pref, 'voice')}:${escapeText(p.value)}`))
    }
    for (const e of c.emails) {
      if (!e.value) continue
      lines.push(
        foldLine(`EMAIL;TYPE=${typeParam(e.type, e.pref, 'internet')}:${escapeText(e.value)}`)
      )
    }
    for (const a of c.addresses) {
      const body = `;;${escapeText(a.street ?? '')};${escapeText(a.city ?? '')};${escapeText(
        a.region ?? ''
      )};${escapeText(a.postalCode ?? '')};${escapeText(a.country ?? '')}`
      lines.push(foldLine(`ADR;TYPE=${typeParam(a.type, a.pref, 'home')}:${body}`))
    }

    if (c.birthday) lines.push(`BDAY:${c.birthday}`)
    if (c.url) lines.push(foldLine(`URL:${escapeText(c.url)}`))
    if (c.relationship) lines.push(foldLine(`X-RELATIONSHIP:${escapeText(c.relationship)}`))
    if (c.notes) lines.push(foldLine(`NOTE:${escapeText(c.notes)}`))
    if (c.photo) {
      const m = c.photo.match(/^data:image\/([\w.+-]+);base64,(.*)$/s)
      if (m) {
        lines.push(foldLine(`PHOTO;ENCODING=b;TYPE=${m[1].toUpperCase()}:${m[2]}`))
      } else if (/^https?:/i.test(c.photo)) {
        lines.push(foldLine(`PHOTO;VALUE=uri:${c.photo}`))
      }
    }
    if (c.externalId) lines.push(foldLine(`UID:${c.externalId}`))

    lines.push('END:VCARD')
    blocks.push(lines.join('\r\n'))
  }
  return blocks.length > 0 ? `${blocks.join('\r\n')}\r\n` : ''
}
