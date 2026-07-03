/**
 * Cross-domain leverage: decide which habits should auto-complete a given day
 * from a life-logging source's metrics (Oura first — see `electron/integrations/oura.ts`
 * for the impure orchestration that reads `habits`/`habitEntries` and calls this).
 *
 * `autoLinkSource` is a source-prefixed metric key (e.g. `'oura-sleep-score'`) so the
 * same `habits` table can host auto-links from multiple future sources (Whoop,
 * Strava, screen-time, …) without key collisions — each source just needs to fill
 * the matching keys in its `metrics` lookup.
 *
 * Pure — no DB, no Electron — so it's testable against plain objects.
 */

export interface HabitAutoLinkConfig {
  id: number
  autoLinkSource: string | null
  autoLinkThreshold: number | null
}

/** Metric key (matches a habit's `autoLinkSource`) → today's value, or null/undefined if unknown. */
export type AutoLinkMetrics = Record<string, number | null | undefined>

export interface HabitAutoFill {
  habitId: number
  date: string
}

/**
 * A habit qualifies when it has BOTH `autoLinkSource` and `autoLinkThreshold` set
 * and the matching metric is a number that meets or exceeds the threshold. Habits
 * with no auto-link configured, or whose metric is missing/non-numeric, are skipped.
 */
export function computeHabitAutoFills(
  habitsWithLinks: HabitAutoLinkConfig[],
  date: string,
  metrics: AutoLinkMetrics
): HabitAutoFill[] {
  const out: HabitAutoFill[] = []
  for (const h of habitsWithLinks) {
    if (!h.autoLinkSource || h.autoLinkThreshold == null) continue
    const value = metrics[h.autoLinkSource]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value >= h.autoLinkThreshold) out.push({ habitId: h.id, date })
  }
  return out
}
