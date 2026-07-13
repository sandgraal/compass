/**
 * Insight lifecycle — gives "Worth a look" a memory.
 *
 * `insights:list` computes the live insights (rule detectors from
 * `insights.ts` + series anomalies from `insights-discovery.ts`), reconciles
 * them against the `insight_log` table (first-seen / last-seen / dismissed /
 * pinned, keyed by a stable per-insight key), and returns them enriched:
 * pinned first, dismissed separated out, `isNew` when an insight appeared
 * since the previous visit. `insights:dismiss` / `insights:pin` flip the flags.
 *
 * The detectors stay pure — this layer is the only writer of `insight_log`,
 * and on a pre-migration DB it degrades to a plain list (no memory, no throw).
 *
 * Keys: detectors emit fixed title templates where only the numbers vary, so
 * the derived key = kind + digit-stripped title is stable run-to-run for the
 * same underlying subject ("Dining spending is up 34%" and "…up 41%" share a
 * key; two different categories don't). Series anomalies carry an explicit key.
 */
import { eq, inArray } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { appSettings, insightLog } from '../db/schema'
import { type Insight, buildInsights } from './insights'
import { detectSeriesAnomalies } from './insights-discovery'

type Db = ReturnType<typeof getDb>

export type LiveInsightKind = Insight['kind'] | 'series-anomaly'

export interface LiveInsight {
  key: string
  kind: LiveInsightKind
  severity: 'info' | 'warn'
  title: string
  detail: string
  route: string
  firstSeen: number
  pinned: boolean
  isNew: boolean
  dismissedAt: number | null
}

export interface InsightsListResult {
  generatedAt: string
  /** Active insights — pinned first, then warnings before infos. */
  insights: LiveInsight[]
  /** Dismissed insights that are still firing (restorable). */
  dismissed: LiveInsight[]
}

const LAST_VISIT_KEY = 'insights.lastSeenAt'
const MAX_KEY_LENGTH = 300

/** Stable identity for a detector insight: kind + digit-stripped title. */
export function insightKey(insight: Pick<Insight, 'kind' | 'title'>): string {
  const slug = insight.title
    .toLowerCase()
    .replace(/[\d$,.%×]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${insight.kind}:${slug}`.slice(0, MAX_KEY_LENGTH)
}

interface Keyed {
  key: string
  kind: LiveInsightKind
  severity: 'info' | 'warn'
  title: string
  detail: string
  route: string
}

function computeKeyed(db: Db, now: Date): Keyed[] {
  const base = buildInsights(db, now).insights.map((i) => ({ ...i, key: insightKey(i) }))
  const anomalies = detectSeriesAnomalies(db, now)
  const out: Keyed[] = []
  const seen = new Set<string>()
  for (const i of [...base, ...anomalies]) {
    if (seen.has(i.key)) continue // identical templates collapse to one row
    seen.add(i.key)
    out.push(i)
  }
  return out
}

export function listInsights(db: Db, now: Date = new Date()): InsightsListResult {
  const computed = computeKeyed(db, now)

  let logByKey = new Map<
    string,
    { firstSeen: number; pinned: boolean; dismissedAt: number | null }
  >()
  let prevVisit: number | null = null
  try {
    // Read the previous visit marker BEFORE touching it — "new" means "appeared
    // since the last time this list was rendered".
    const visitRow = db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, LAST_VISIT_KEY))
      .all()[0]
    prevVisit = visitRow ? Number(visitRow.value) || null : null

    for (const i of computed) {
      db.insert(insightLog)
        .values({
          key: i.key,
          kind: i.kind,
          severity: i.severity,
          title: i.title,
          detail: i.detail,
          route: i.route,
          firstSeen: now,
          lastSeen: now
        })
        .onConflictDoUpdate({
          target: insightLog.key,
          // Refresh the display fields — the numbers inside a title drift
          // run-to-run even though the key stays put.
          set: {
            lastSeen: now,
            severity: i.severity,
            title: i.title,
            detail: i.detail,
            route: i.route
          }
        })
        .run()
    }
    if (computed.length > 0) {
      const rows = db
        .select()
        .from(insightLog)
        .where(
          inArray(
            insightLog.key,
            computed.map((i) => i.key)
          )
        )
        .all()
      logByKey = new Map(
        rows.map((r) => [
          r.key,
          {
            firstSeen: r.firstSeen.getTime(),
            pinned: r.pinned,
            dismissedAt: r.dismissedAt ? r.dismissedAt.getTime() : null
          }
        ])
      )
    }
    db.insert(appSettings)
      .values({ key: LAST_VISIT_KEY, value: String(now.getTime()) })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: String(now.getTime()), updatedAt: now }
      })
      .run()
  } catch {
    // Pre-migration DB (no insight_log yet): plain list, no memory.
  }

  const live: LiveInsight[] = computed.map((i) => {
    const row = logByKey.get(i.key)
    const firstSeen = row?.firstSeen ?? now.getTime()
    return {
      ...i,
      firstSeen,
      pinned: row?.pinned ?? false,
      dismissedAt: row?.dismissedAt ?? null,
      isNew: prevVisit != null && firstSeen > prevVisit
    }
  })

  const active = live.filter((i) => i.dismissedAt == null)
  const dismissed = live.filter((i) => i.dismissedAt != null)
  active.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.severity !== b.severity) return a.severity === 'warn' ? -1 : 1
    return 0
  })
  return { generatedAt: now.toISOString(), insights: active, dismissed }
}

export function setDismissed(
  db: Db,
  key: string,
  dismissed: boolean,
  now: Date = new Date()
): void {
  db.update(insightLog)
    .set({ dismissedAt: dismissed ? now : null })
    .where(eq(insightLog.key, key))
    .run()
}

export function setPinned(db: Db, key: string, pinned: boolean): void {
  db.update(insightLog).set({ pinned }).where(eq(insightLog.key, key)).run()
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH
}

export function registerInsightLifecycleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('insights:list', (): InsightsListResult => {
    return listInsights(getDb())
  })
  ipcMain.handle(
    'insights:dismiss',
    (_event, key: unknown, dismissed: unknown): { success: boolean } => {
      if (!validKey(key)) return { success: false }
      try {
        setDismissed(getDb(), key, dismissed !== false)
        return { success: true }
      } catch {
        return { success: false }
      }
    }
  )
  ipcMain.handle('insights:pin', (_event, key: unknown, pinned: unknown): { success: boolean } => {
    if (!validKey(key)) return { success: false }
    try {
      setPinned(getDb(), key, pinned === true)
      return { success: true }
    } catch {
      return { success: false }
    }
  })
}
