/**
 * Entities IPC — the cross-reference surface.
 *
 * `entities:list` reads the `derived_entities` projection cache (built by the
 * ingest hook from `electron/lib/entities.ts`) so any tab can show the people /
 * merchants / places / subscription candidates derived from the timeline WITHOUT
 * re-scanning 191k records. `entities:promote` materializes ONE chosen derived
 * entity into its owned table (reusing the real writers), which is the only path
 * that ever writes owned data — nothing is auto-created. `entities:refresh`
 * rebuilds the cache on demand (e.g. after the user edits contacts).
 *
 * Read-only toward the vault + raw finance rows: this reads `records` (the
 * deliberate Phase-10.7 relaxation) + owned tables only.
 */

import { type SQL, and, asc, desc, eq, like } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { derivedEntities } from '../db/schema'
import type { EntityAttrs, EntityKind } from '../lib/entities'
import { refreshDerivedEntities } from '../lib/entities-projection'
import { promoteDerivedContact } from './contacts'
import { trackDetectedSubscription } from './subscriptions'

const KINDS: EntityKind[] = ['person', 'merchant', 'place', 'subscription-candidate']
const MAX_LIMIT = 500

export interface EntityListItem {
  kind: EntityKind
  name: string
  key: string
  count: number
  sources: string[]
  firstSeen: number | null
  lastSeen: number | null
  attrs: EntityAttrs
  promotedId: number | null
  promotedKind: 'contact' | 'subscription' | 'place' | null
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function registerEntitiesHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'entities:list',
    (_event, opts: { kind: EntityKind; q?: string; limit?: number; offset?: number }) => {
      const kind = opts?.kind
      if (!KINDS.includes(kind)) throw new Error(`entities:list: unknown kind ${kind}`)
      const db = getDb()
      const limit = Math.min(Math.max(1, Number(opts?.limit) || 100), MAX_LIMIT)
      const offset = Math.max(0, Number(opts?.offset) || 0)
      const q = opts?.q?.trim()

      const where: SQL[] = [eq(derivedEntities.kind, kind)]
      if (q) where.push(like(derivedEntities.name, `%${q}%`))

      const rows = db
        .select()
        .from(derivedEntities)
        .where(and(...where))
        .orderBy(desc(derivedEntities.count), asc(derivedEntities.id))
        .limit(limit)
        .offset(offset)
        .all()

      return rows.map<EntityListItem>((r) => ({
        kind: r.kind as EntityKind,
        name: r.name,
        key: r.matchKey,
        count: r.count,
        sources: parseJson<string[]>(r.sources, []),
        firstSeen: r.firstSeen ? r.firstSeen.getTime() : null,
        lastSeen: r.lastSeen ? r.lastSeen.getTime() : null,
        attrs: parseJson<EntityAttrs>(r.attrs, {}),
        promotedId: r.promotedId ?? null,
        promotedKind: (r.promotedKind as EntityListItem['promotedKind']) ?? null
      }))
    }
  )

  // Materialize one derived entity into its owned table. Idempotent (the owned
  // writers dedupe by external id); flips the projection row's promoted-* inline
  // so the UI updates without a full rebuild.
  ipcMain.handle('entities:promote', (_event, req: { kind: EntityKind; key: string }) => {
    const { kind, key } = req ?? {}
    if (!KINDS.includes(kind) || !key) throw new Error('entities:promote: kind and key required')
    const db = getDb()
    const row = db
      .select()
      .from(derivedEntities)
      .where(and(eq(derivedEntities.kind, kind), eq(derivedEntities.matchKey, key)))
      .all()[0]
    if (!row) throw new Error('entities:promote: entity not found')
    const attrs = parseJson<EntityAttrs>(row.attrs, {})

    let promotedKind: EntityListItem['promotedKind']
    let promotedId: number

    if (kind === 'person') {
      const res = promoteDerivedContact(row.name, row.matchKey)
      promotedKind = 'contact'
      promotedId = res.id
    } else if (kind === 'subscription-candidate') {
      const res = trackDetectedSubscription({
        merchant: row.matchKey,
        account: attrs.primarySource ?? '—',
        cadence: attrs.cadence,
        medianAmount: attrs.medianAmount
      })
      promotedKind = 'subscription'
      promotedId = res.id
    } else {
      // merchant / place: the owned `places` table lands in a later phase.
      return { success: false, error: `promote not supported for ${kind} yet` }
    }

    db.update(derivedEntities)
      .set({ promotedKind, promotedId })
      .where(and(eq(derivedEntities.kind, kind), eq(derivedEntities.matchKey, key)))
      .run()
    return { success: true, promotedKind, promotedId }
  })

  ipcMain.handle('entities:refresh', () => refreshDerivedEntities(getDb()))
}
