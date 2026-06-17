/**
 * Records → markdown writer (Phase 10.1 — "The Acquisition Engine").
 *
 * Mirrors `contacts-extractor.ts`: after a Drop Zone import we regenerate
 * `timeline/overview.md` so the knowledge base (and Ask Compass) reflects what's
 * on the unified timeline.
 *
 * SECURITY: this is a SUMMARY only — counts by source/type/year, the date span,
 * a few recent titles, and an "on this day" recap. A unified life-timeline can
 * hold sensitive events, so the full per-record detail is deliberately NOT dumped
 * into the knowledge base (and thus not into the semantic index / MCP). Per-record
 * exposure is a later opt-in.
 */

import { getDb } from '../db/client'
import { records } from '../db/schema'
import { KNOWLEDGE_DIR } from '../paths'
import { updateKnowledgeFile } from './writer'

export interface RecordSummaryRow {
  source: string
  type: string
  occurredAt: Date | null
  title: string
}

/**
 * Escape Markdown inline punctuation in imported, user-controlled labels
 * (title / source / type) before they go into `overview.md`. The KnowledgeBase
 * Markdown→HTML render doesn't sanitize, so an unescaped value could otherwise
 * become a clickable link or raw HTML.
 */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_[\]()<>|~#]/g, '\\$&')
}

/**
 * Build the `timeline/overview.md` content from the full record list. `now`, when
 * provided, drives the "on this day" recap (records sharing today's month + day).
 */
export function buildRecordsOverviewMarkdown(
  rows: RecordSummaryRow[],
  stamp: string,
  now?: Date
): string {
  const lines: string[] = [
    '# Timeline Overview',
    '',
    `> Auto-updated by Compass — ${stamp}.`,
    '> Data exports you imported, on one unified timeline. Manage them in the **Timeline** page.',
    '> This is a summary; full per-event detail lives in the records database, not here.',
    ''
  ]

  if (rows.length === 0) {
    lines.push('_No imported records yet. Drag a data export onto the Timeline page._', '')
    return `${lines.join('\n')}\n`
  }

  const bySource = new Map<string, number>()
  const byType = new Map<string, number>()
  const byYear = new Map<number, number>()
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = Number.NEGATIVE_INFINITY
  for (const r of rows) {
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
    if (r.occurredAt) {
      const t = r.occurredAt.getTime()
      if (t < minTs) minTs = t
      if (t > maxTs) maxTs = t
      // UTC year — consistent with the toISOString() span/recent rendering below
      // (date-only imports are stored at UTC midnight).
      const y = r.occurredAt.getUTCFullYear()
      byYear.set(y, (byYear.get(y) ?? 0) + 1)
    }
  }

  lines.push(`**${rows.length}** record${rows.length === 1 ? '' : 's'} on your timeline.`, '')
  if (Number.isFinite(minTs) && Number.isFinite(maxTs)) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    lines.push(`**Span:** ${day(minTs)} → ${day(maxTs)}`, '')
  }

  // Shared "## Heading\n- **label** — count" block for the breakdown sections.
  const countList = (heading: string, entries: Array<[string, number]>): void => {
    lines.push(heading, '')
    for (const [label, count] of entries) lines.push(`- **${mdEscape(label)}** — ${count}`)
    lines.push('')
  }
  const byCountDesc = (a: [string, number], b: [string, number]): number => b[1] - a[1]

  countList('## By source', [...bySource.entries()].sort(byCountDesc))
  countList('## By type', [...byType.entries()].sort(byCountDesc))
  if (byYear.size) {
    const years: Array<[string, number]> = [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, c]) => [String(y), c])
    countList('## By year', years)
  }

  const recent = rows
    .filter((r) => r.occurredAt)
    .sort((a, b) => (b.occurredAt as Date).getTime() - (a.occurredAt as Date).getTime())
    .slice(0, 10)
  if (recent.length) {
    lines.push('## Most recent', '')
    for (const r of recent) {
      lines.push(
        `- ${(r.occurredAt as Date).toISOString().slice(0, 10)} — ${mdEscape(r.title)} _(${mdEscape(r.source)})_`
      )
    }
    lines.push('')
  }

  if (now) {
    // Match in UTC — date-only imports are stored at UTC midnight, so a UTC calendar
    // day recovers their true source date (and matches the toISOString rendering
    // above); local getters would shift them a day in west-of-UTC zones.
    const m = now.getUTCMonth()
    const d = now.getUTCDate()
    const onThisDay = rows
      .filter(
        (r) =>
          r.occurredAt != null &&
          r.occurredAt.getUTCMonth() === m &&
          r.occurredAt.getUTCDate() === d
      )
      .sort((a, b) => (b.occurredAt as Date).getTime() - (a.occurredAt as Date).getTime())
    if (onThisDay.length) {
      const label = now.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
      })
      lines.push(`## On this day (${label})`, '')
      for (const r of onThisDay.slice(0, 15)) {
        lines.push(
          `- ${(r.occurredAt as Date).getUTCFullYear()} — ${mdEscape(r.title)} _(${mdEscape(r.source)})_`
        )
      }
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

/** Regenerate `timeline/overview.md` from the records table. Best-effort. */
export function updateRecordsKnowledge(): void {
  const db = getDb()
  const rows = db
    .select({
      source: records.source,
      type: records.type,
      occurredAt: records.occurredAt,
      title: records.title
    })
    .from(records)
    .all()
  const now = new Date()
  updateKnowledgeFile(
    KNOWLEDGE_DIR,
    'timeline/overview.md',
    buildRecordsOverviewMarkdown(rows, now.toLocaleString(), now)
  )
}
