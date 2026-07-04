/**
 * Rideshare trip recognizers (Phase 10 — "The Acquisition Engine").
 *
 * A dropped Uber or Lyft trip-history CSV (from each app's privacy/"download
 * your data" export) becomes one timeline record per ride — "Uber ride ·
 * $18.50", dated, with the dropoff address in the body so it flows into the
 * Places directory via the entity extractor.
 *
 * FORMAT CAVEAT: Uber's export columns are reasonably documented; Lyft's are
 * not. Both parsers match on a list of candidate column names and detect
 * conservatively (Lyft requires pickup+dropoff and the ABSENCE of Uber's "Begin
 * Trip" column, so the two never fight over a file). Unvalidated against a real
 * export — sharpen the column names when one lands. Rows without a usable
 * timestamp are skipped rather than dated `null`-and-buried.
 */

import { fromHeaderRow, matchHeader, parseCSV } from './csv'
import { parseWhen } from './dates'
import type { Recognizer, RecordInput } from './recognizers'

function money(s: string | undefined): { amount: number; text: string } | null {
  if (!s) return null
  const t = s.replace(/[$,\s]/g, '').trim()
  if (!t) return null
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return null
  return { amount: n, text: `$${n.toFixed(2)}` }
}

// ─── Uber ────────────────────────────────────────────────────────────────────
export const UBER_RECOGNIZER: Recognizer = {
  id: 'uber',
  label: 'Uber trip history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const lower = f.text.toLowerCase()
    return lower.includes('begin trip') && lower.includes('dropoff')
  },
  parse: (f) => {
    const rows = parseCSV(fromHeaderRow(f.text, 'Begin Trip'))
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cWhen = matchHeader(keys, 'Begin Trip Time', 'Request Time', 'Trip Request Time')
    const cDrop = matchHeader(keys, 'Dropoff Address', 'Drop Off Address', 'Dropoff')
    const cCity = matchHeader(keys, 'City')
    const cFare = matchHeader(keys, 'Fare Amount', 'Fare', 'Amount')
    const cStatus = matchHeader(keys, 'Trip or Order Status', 'Status')

    const out: RecordInput[] = []
    for (const r of rows) {
      // Skip cancelled/unfulfilled rows — they have no real trip.
      const status = cStatus ? r[cStatus].trim().toLowerCase() : ''
      if (status && !/complet|fulfil|finished/.test(status)) continue
      const when = parseWhen(cWhen ? r[cWhen] : '')
      if (when == null) continue
      const fare = cFare ? money(r[cFare]) : null
      const dropoff = cDrop ? r[cDrop].trim() : ''
      const city = cCity ? r[cCity].trim() : ''
      out.push({
        source: 'uber',
        type: 'ride',
        occurredAt: when,
        title: `Uber ride${fare ? ` · ${fare.text}` : city ? ` · ${city}` : ''}`,
        body: dropoff || undefined,
        payload: r,
        naturalKey: `${cWhen ? r[cWhen].trim() : ''}|${dropoff}`
      })
    }
    return out
  }
}

// ─── Lyft ────────────────────────────────────────────────────────────────────
export const LYFT_RECOGNIZER: Recognizer = {
  id: 'lyft',
  label: 'Lyft ride history',
  detect: (f) => {
    if (f.ext !== 'csv') return false
    const lower = f.text.toLowerCase()
    if (lower.includes('begin trip')) return false // that's Uber's shape
    const isLyft = /lyft/i.test(f.name) || lower.includes('lyft')
    return isLyft && lower.includes('pickup') && lower.includes('dropoff')
  },
  parse: (f) => {
    const rows = parseCSV(f.text)
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    const cWhen = matchHeader(keys, 'Requested', 'Request Time', 'Timestamp', 'Ride Date', 'Time')
    const cDrop = matchHeader(keys, 'Dropoff', 'Drop Off', 'Dropoff Address', 'Destination')
    const cFare = matchHeader(keys, 'Amount', 'Total', 'Fare', 'Price')

    const out: RecordInput[] = []
    for (const r of rows) {
      const when = parseWhen(cWhen ? r[cWhen] : '')
      if (when == null) continue
      const fare = cFare ? money(r[cFare]) : null
      const dropoff = cDrop ? r[cDrop].trim() : ''
      out.push({
        source: 'lyft',
        type: 'ride',
        occurredAt: when,
        title: `Lyft ride${fare ? ` · ${fare.text}` : ''}`,
        body: dropoff || undefined,
        payload: r,
        naturalKey: `${cWhen ? r[cWhen].trim() : ''}|${dropoff}`
      })
    }
    return out
  }
}
