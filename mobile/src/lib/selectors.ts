/**
 * Bundle selectors (Phase 4c) — pure readers over a decrypted snapshot for the
 * read-only viewer. v3 `allTables` rows are RAW sqlite rows (snake_case
 * columns), exactly as the desktop's drift-proof capture stores them.
 *
 * No React imports — unit-tested from the root repo alongside the decrypt core.
 */

import type { SnapshotBundle } from './snapshot'

export interface TimelineItem {
  id: number
  source: string
  type: string
  occurredAt: number | null
  title: string
  body: string | null
}

export interface SnapshotSummary {
  exportedAt: string
  appVersion: string
  recordCount: number
  sourceCounts: Array<{ source: string; count: number }>
  taskCount: number
  habitCount: number
  contactCount: number
  documentCount: number
}

function table(bundle: SnapshotBundle, name: string): Record<string, unknown>[] {
  const rows = bundle.allTables?.[name]
  return Array.isArray(rows) ? rows : []
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Newest-first timeline rows (undated records sink to the end). */
export function timelineItems(bundle: SnapshotBundle, limit = 200): TimelineItem[] {
  return table(bundle, 'records')
    .map((r) => ({
      id: num(r.id) ?? 0,
      source: str(r.source),
      type: str(r.type),
      occurredAt: num(r.occurred_at),
      title: str(r.title),
      body: typeof r.body === 'string' ? r.body : null
    }))
    .sort((a, b) => (b.occurredAt ?? -1) - (a.occurredAt ?? -1))
    .slice(0, limit)
}

/** Headline counts for the viewer's summary header. */
export function snapshotSummary(bundle: SnapshotBundle): SnapshotSummary {
  const records = table(bundle, 'records')
  const bySource = new Map<string, number>()
  for (const r of records) {
    const s = str(r.source) || '(unknown)'
    bySource.set(s, (bySource.get(s) ?? 0) + 1)
  }
  return {
    exportedAt: bundle.exportedAt,
    appVersion: bundle.appVersion,
    recordCount: records.length,
    sourceCounts: [...bySource.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
    taskCount: table(bundle, 'checklist_items').length,
    habitCount: table(bundle, 'habits').length,
    contactCount: table(bundle, 'contacts').length,
    documentCount: table(bundle, 'documents').length
  }
}
