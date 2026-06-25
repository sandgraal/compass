/**
 * LinkedIn connections recognizer (Phase 10 — "The Acquisition Engine").
 *
 * Opens the professional-graph domain: a dropped LinkedIn `Connections.csv`
 * becomes one timeline record per connection ("Connected with Jane Smith —
 * Product Manager at Globex"), dated when you connected. Your network, owned.
 *
 * LinkedIn prefixes the real header with a "Notes:" disclaimer + blank line, so
 * detection scans the head (not line 0) and parsing skips the preamble via
 * `fromHeaderRow`. Reuses the shared `matchHeader` resolver + `parseWhen`; zero
 * new deps. Note: the profile URL can be blank when a member limited visibility,
 * so the dedup key falls back to name + connect date.
 */

import { fromHeaderRow, matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

export const LINKEDIN_RECOGNIZER: Recognizer = {
  id: 'linkedin',
  label: 'LinkedIn connections',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const head = f.text.slice(0, 8192).toLowerCase()
    return head.includes('first name') && head.includes('connected on')
  },
  parse: (f) => {
    const rows = parseCSV(fromHeaderRow(f.text, 'First Name', 'Connected On'))
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cFirst = matchHeader(keys, 'First Name')
    const cLast = matchHeader(keys, 'Last Name')
    const cCompany = matchHeader(keys, 'Company')
    const cPosition = matchHeader(keys, 'Position')
    const cUrl = matchHeader(keys, 'URL')
    const cConnectedOn = matchHeader(keys, 'Connected On')

    const out: RecordInput[] = []
    for (const r of rows) {
      const name = [cFirst ? r[cFirst].trim() : '', cLast ? r[cLast].trim() : '']
        .filter(Boolean)
        .join(' ')
      if (!name) continue
      const position = cPosition ? r[cPosition].trim() : ''
      const company = cCompany ? r[cCompany].trim() : ''
      const role = [position, company].filter(Boolean).join(' at ')
      const url = cUrl ? r[cUrl].trim() : ''
      const connectedOn = cConnectedOn ? r[cConnectedOn].trim() : ''
      out.push({
        source: 'linkedin',
        type: 'connection',
        occurredAt: parseWhen(connectedOn),
        title: `Connected with ${name}`,
        body: role || undefined,
        payload: r,
        // Profile URL is the stable per-connection key; fall back to name + connect
        // date since LinkedIn blanks the URL when a member limited visibility.
        naturalKey: url || `${name}|${connectedOn}`
      })
    }
    return out
  }
}

// ── The rest of the LinkedIn "Basic" export — one record per dated CSV ─────────
// All share source 'linkedin'. Detection keys on each file's distinctive header so
// the recognizers never cross-claim (or grab Connections). Reuses parseCSV +
// matchHeader + parseWhen.

const headHas = (text: string, ...needles: string[]): boolean => {
  const head = text.slice(0, 4096).toLowerCase()
  return needles.every((n) => head.includes(n.toLowerCase()))
}

/** Parse a LinkedIn date cell (formats vary wildly) → epoch ms or null. */
function liDate(s: string | undefined): number | null {
  const raw = (s ?? '').trim()
  if (!raw) return null
  // "Event Time" is a range ("Aug 06, 2021 02:00 PM - …") → take the start.
  const t = raw.split(' - ')[0].trim()
  const ms = parseWhen(t)
  if (ms != null) return ms
  // LinkedIn Learning uses a seconds-less "YYYY-MM-DD HH:MM UTC" that trips parseWhen.
  const m = t.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}) UTC$/)
  return m ? parseWhen(`${m[1]}:00 UTC`) : null
}

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// messages.csv — CONTENT-LIGHT daily counts per conversation (message text NEVER stored).
export const LINKEDIN_MESSAGES_RECOGNIZER: Recognizer = {
  id: 'linkedin-messages',
  label: 'LinkedIn messages',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'conversation id', 'content'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cTitle = matchHeader(keys, 'CONVERSATION TITLE')
    const cFrom = matchHeader(keys, 'FROM')
    const cDate = matchHeader(keys, 'DATE')
    const cConvo = matchHeader(keys, 'CONVERSATION ID')
    const perDay = new Map<string, { count: number; label: string }>()
    for (const r of rows) {
      const when = cDate ? liDate(r[cDate]) : null
      if (when == null) continue
      const convo = cConvo ? r[cConvo].trim() : ''
      const label =
        (cTitle ? r[cTitle].trim() : '') || (cFrom ? r[cFrom].trim() : '') || 'a conversation'
      const key = `${localDay(when)}|${convo || label}`
      const cur = perDay.get(key)
      if (cur) cur.count++
      else perDay.set(key, { count: 1, label })
    }
    const out: RecordInput[] = []
    for (const [key, { count, label }] of perDay) {
      const day = key.split('|')[0]
      out.push({
        source: 'linkedin',
        type: 'messages',
        occurredAt: new Date(`${day}T00:00:00`).getTime(),
        title: `${count} message${count === 1 ? '' : 's'} — ${label.slice(0, 80)}`,
        naturalKey: `li-msg|${key}`
      })
    }
    return out
  }
}

// Positions.csv — career history.
export const LINKEDIN_POSITIONS_RECOGNIZER: Recognizer = {
  id: 'linkedin-positions',
  label: 'LinkedIn positions',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'company name', 'title', 'started on'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cCompany = matchHeader(keys, 'Company Name')
    const cTitle = matchHeader(keys, 'Title')
    const cLoc = matchHeader(keys, 'Location')
    const cStart = matchHeader(keys, 'Started On')
    const out: RecordInput[] = []
    for (const r of rows) {
      const company = cCompany ? r[cCompany].trim() : ''
      const title = cTitle ? r[cTitle].trim() : ''
      if (!company && !title) continue
      out.push({
        source: 'linkedin',
        type: 'job',
        occurredAt: cStart ? liDate(r[cStart]) : null,
        title: [title, company].filter(Boolean).join(' at ') || 'Position',
        body: cLoc ? r[cLoc].trim() || undefined : undefined,
        naturalKey: `li-pos|${company}|${title}`
      })
    }
    return out
  }
}

// Certifications.csv
export const LINKEDIN_CERTIFICATIONS_RECOGNIZER: Recognizer = {
  id: 'linkedin-certifications',
  label: 'LinkedIn certifications',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'authority', 'license number'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cName = matchHeader(keys, 'Name')
    const cAuth = matchHeader(keys, 'Authority')
    const cStart = matchHeader(keys, 'Started On')
    const out: RecordInput[] = []
    for (const r of rows) {
      const name = cName ? r[cName].trim() : ''
      if (!name) continue
      const auth = cAuth ? r[cAuth].trim() : ''
      out.push({
        source: 'linkedin',
        type: 'certification',
        occurredAt: cStart ? liDate(r[cStart]) : null,
        title: name,
        body: auth || undefined,
        naturalKey: `li-cert|${name}`
      })
    }
    return out
  }
}

// Endorsement_Received_Info.csv — skill endorsements.
export const LINKEDIN_ENDORSEMENTS_RECOGNIZER: Recognizer = {
  id: 'linkedin-endorsements',
  label: 'LinkedIn endorsements',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'endorsement date', 'skill name'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cDate = matchHeader(keys, 'Endorsement Date')
    const cSkill = matchHeader(keys, 'Skill Name')
    const cFirst = matchHeader(keys, 'Endorser First Name')
    const cLast = matchHeader(keys, 'Endorser Last Name')
    const out: RecordInput[] = []
    for (const r of rows) {
      const skill = cSkill ? r[cSkill].trim() : ''
      if (!skill) continue
      const who = [cFirst ? r[cFirst].trim() : '', cLast ? r[cLast].trim() : '']
        .filter(Boolean)
        .join(' ')
      const date = cDate ? r[cDate].trim() : ''
      out.push({
        source: 'linkedin',
        type: 'endorsement',
        occurredAt: liDate(date),
        title: who ? `${who} endorsed you for ${skill}` : `Endorsed for ${skill}`,
        naturalKey: `li-end|${date}|${who}|${skill}`
      })
    }
    return out
  }
}

// Invitations.csv — connection invitations (incoming/outgoing).
export const LINKEDIN_INVITATIONS_RECOGNIZER: Recognizer = {
  id: 'linkedin-invitations',
  label: 'LinkedIn invitations',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'sent at', 'direction', 'inviterprofileurl'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cFrom = matchHeader(keys, 'From')
    const cTo = matchHeader(keys, 'To')
    const cSent = matchHeader(keys, 'Sent At')
    const cDir = matchHeader(keys, 'Direction')
    const out: RecordInput[] = []
    for (const r of rows) {
      const dir = (cDir ? r[cDir].trim() : '').toUpperCase()
      const from = cFrom ? r[cFrom].trim() : ''
      const to = cTo ? r[cTo].trim() : ''
      const outgoing = dir === 'OUTGOING'
      const who = outgoing ? to : from
      if (!who) continue
      const sent = cSent ? r[cSent].trim() : ''
      out.push({
        source: 'linkedin',
        type: 'invitation',
        occurredAt: liDate(sent),
        title: outgoing ? `Invited ${who}` : `Invitation from ${who}`,
        naturalKey: `li-inv|${dir}|${sent}|${who}`
      })
    }
    return out
  }
}

// Company Follows.csv
export const LINKEDIN_FOLLOWS_RECOGNIZER: Recognizer = {
  id: 'linkedin-follows',
  label: 'LinkedIn company follows',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'organization', 'followed on'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cOrg = matchHeader(keys, 'Organization')
    const cOn = matchHeader(keys, 'Followed On')
    const out: RecordInput[] = []
    for (const r of rows) {
      const org = cOrg ? r[cOrg].trim() : ''
      if (!org) continue
      out.push({
        source: 'linkedin',
        type: 'follow',
        occurredAt: cOn ? liDate(r[cOn]) : null,
        title: `Followed ${org}`,
        naturalKey: `li-follow|${org}`
      })
    }
    return out
  }
}

// Learning.csv — LinkedIn Learning courses.
export const LINKEDIN_LEARNING_RECOGNIZER: Recognizer = {
  id: 'linkedin-learning',
  label: 'LinkedIn Learning',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'content title', 'content type'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cTitle = matchHeader(keys, 'Content Title')
    const cType = matchHeader(keys, 'Content Type')
    // The date columns carry "(if completed)" / "(if viewed)" suffixes, so resolve
    // them by substring rather than the exact-name matcher.
    const cDone = keys.find((k) => /completed at/i.test(k))
    const cWatched = keys.find((k) => /watched date/i.test(k))
    const out: RecordInput[] = []
    // LinkedIn writes the literal "N/A" (not blank) when a course wasn't completed/viewed.
    const real = (v: string | undefined): string => {
      const t = (v ?? '').trim()
      return t.toUpperCase() === 'N/A' ? '' : t
    }
    for (const r of rows) {
      const title = cTitle ? r[cTitle].trim() : ''
      if (!title) continue
      const when = liDate(real(cDone && r[cDone]) || real(cWatched && r[cWatched]))
      out.push({
        source: 'linkedin',
        type: 'learning',
        occurredAt: when,
        title,
        body: cType ? r[cType].trim() || undefined : undefined,
        naturalKey: `li-learn|${title}`
      })
    }
    return out
  }
}

// Events.csv
export const LINKEDIN_EVENTS_RECOGNIZER: Recognizer = {
  id: 'linkedin-events',
  label: 'LinkedIn events',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'event name', 'event time'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cName = matchHeader(keys, 'Event Name')
    const cTime = matchHeader(keys, 'Event Time')
    const out: RecordInput[] = []
    for (const r of rows) {
      const name = cName ? r[cName].trim() : ''
      if (!name) continue
      out.push({
        source: 'linkedin',
        type: 'event',
        occurredAt: cTime ? liDate(r[cTime]) : null,
        title: name,
        naturalKey: `li-event|${name}`
      })
    }
    return out
  }
}

// Jobs/Job Applications.csv
export const LINKEDIN_JOB_APPLICATIONS_RECOGNIZER: Recognizer = {
  id: 'linkedin-job-applications',
  label: 'LinkedIn job applications',
  detect: (f) => f.ext === 'csv' && headHas(f.text, 'application date', 'job title'),
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cDate = matchHeader(keys, 'Application Date')
    const cCompany = matchHeader(keys, 'Company Name')
    const cTitle = matchHeader(keys, 'Job Title')
    const out: RecordInput[] = []
    for (const r of rows) {
      const title = cTitle ? r[cTitle].trim() : ''
      const company = cCompany ? r[cCompany].trim() : ''
      if (!title && !company) continue
      out.push({
        source: 'linkedin',
        type: 'job-application',
        occurredAt: cDate ? liDate(r[cDate]) : null,
        title: `Applied: ${[title, company].filter(Boolean).join(' at ')}`,
        naturalKey: `li-app|${cDate ? r[cDate].trim() : ''}|${title}|${company}`
      })
    }
    return out
  }
}

/** Recommendations_Received / _Given — same header, distinguished by filename. */
function recommendationRecognizer(id: string, file: RegExp, given: boolean): Recognizer {
  return {
    id,
    label: given ? 'LinkedIn recommendations given' : 'LinkedIn recommendations received',
    detect: (f) =>
      f.ext === 'csv' && file.test(f.name) && headHas(f.text, 'creation date', 'job title', 'text'),
    parse: (f) => {
      const rows = parseCSV(f.text)
      if (!rows.length) return []
      const keys = Object.keys(rows[0])
      const cFirst = matchHeader(keys, 'First Name')
      const cLast = matchHeader(keys, 'Last Name')
      const cDate = matchHeader(keys, 'Creation Date')
      const out: RecordInput[] = []
      for (const r of rows) {
        const who = [cFirst ? r[cFirst].trim() : '', cLast ? r[cLast].trim() : '']
          .filter(Boolean)
          .join(' ')
        if (!who) continue
        const date = cDate ? r[cDate].trim() : ''
        out.push({
          source: 'linkedin',
          type: 'recommendation',
          occurredAt: liDate(date),
          title: given ? `Recommended ${who}` : `Recommendation from ${who}`,
          naturalKey: `li-rec|${given ? 'g' : 'r'}|${date}|${who}`
        })
      }
      return out
    }
  }
}

export const LINKEDIN_RECOMMENDATIONS_RECEIVED_RECOGNIZER = recommendationRecognizer(
  'linkedin-recommendations-received',
  /Recommendations_Received/i,
  false
)
export const LINKEDIN_RECOMMENDATIONS_GIVEN_RECOGNIZER = recommendationRecognizer(
  'linkedin-recommendations-given',
  /Recommendations_Given/i,
  true
)
