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
