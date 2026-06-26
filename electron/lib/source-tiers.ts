/**
 * Source value-tiers — the "Curate" track (Phase 10.7).
 *
 * Non-destructive curation: some sources are a FIREHOSE (high-volume, low-signal —
 * e.g. raw browser history, which can be hundreds of thousands of page visits) that
 * would otherwise bury the meaningful events on the timeline. We tag those so the UI
 * can COLLAPSE them by default while keeping every row on disk — "tag & filter, keep
 * everything." Everything else is a SIGNAL source (purchases, media, connections,
 * messages, documents, health, …).
 *
 * Pure + data-driven so it unit-tests and is shared by the records IPC (server-side
 * exclusion) and the Timeline (the toggle + counts).
 */

export type SourceTier = 'firehose' | 'signal'

/** High-volume, low-signal sources collapsed by default on the timeline. */
export const FIREHOSE_SOURCES: ReadonlySet<string> = new Set(['browser'])

export function sourceTier(source: string): SourceTier {
  return FIREHOSE_SOURCES.has(source) ? 'firehose' : 'signal'
}

export function isFirehose(source: string): boolean {
  return FIREHOSE_SOURCES.has(source)
}

/** The firehose sources as an array (for SQL `NOT IN (...)` exclusion). */
export const FIREHOSE_SOURCE_LIST: string[] = [...FIREHOSE_SOURCES]
