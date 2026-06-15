/**
 * Records → markdown writer (Phase 10.1 — "The Acquisition Engine").
 *
 * Mirrors `contacts-extractor.ts`: after a Drop Zone import we regenerate
 * `timeline/overview.md` so the knowledge base (and Ask Compass) reflects what's
 * on the unified timeline.
 *
 * SECURITY: this is a SUMMARY only — counts by source, the date span, and a few
 * recent titles. A unified life-timeline can hold sensitive events, so the full
 * per-record detail is deliberately NOT dumped into the knowledge base (and thus
 * not into the semantic index / MCP). Per-record exposure is a later opt-in.
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

/** Build the `timeline/overview.md` content from the full record list. */
export function buildRecordsOverviewMarkdown(rows: RecordSummaryRow[], stamp: string): string {
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
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = Number.NEGATIVE_INFINITY
  for (const r of rows) {
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
    if (r.occurredAt) {
      const t = r.occurredAt.getTime()
      if (t < minTs) minTs = t
      if (t > maxTs) maxTs = t
    }
  }

  lines.push(`**${rows.length}** record${rows.length === 1 ? '' : 's'} on your timeline.`, '')
  if (Number.isFinite(minTs) && Number.isFinite(maxTs)) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    lines.push(`**Span:** ${day(minTs)} → ${day(maxTs)}`, '')
  }

  lines.push('## By source', '')
  for (const [source, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${source}** — ${count}`)
  }
  lines.push('')

  const recent = rows
    .filter((r) => r.occurredAt)
    .sort((a, b) => (b.occurredAt as Date).getTime() - (a.occurredAt as Date).getTime())
    .slice(0, 10)
  if (recent.length) {
    lines.push('## Most recent', '')
    for (const r of recent) {
      lines.push(
        `- ${(r.occurredAt as Date).toISOString().slice(0, 10)} — ${r.title} _(${r.source})_`
      )
    }
    lines.push('')
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
  updateKnowledgeFile(
    KNOWLEDGE_DIR,
    'timeline/overview.md',
    buildRecordsOverviewMarkdown(rows, new Date().toLocaleString())
  )
}
