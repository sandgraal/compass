/**
 * Curation exclusions — the user's durable "no" list (see the schema comment on
 * `curation_exclusions`). Shared helpers over an injected Drizzle handle so the
 * contacts writer, the entities projection, and the curation IPC all read/write
 * the same table the same way.
 *
 * Same access pattern as `timeline_mutes` / `loadMuteSet`: writes are idempotent
 * (`.onConflictDoNothing()` on the (kind, target) unique index) and reads collapse
 * into a Set, wrapped in try/catch so a DB that predates the table (packaged
 * builds mid-upgrade) just behaves as "no exclusions" instead of throwing.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { curationExclusions } from '../db/schema'

type Db = ReturnType<typeof getDb>

/** The known exclusion kinds. Free text in the schema; validated at the IPC edge. */
export const EXCLUSION_KINDS = [
  'contact-tombstone',
  'contact-merged',
  'entity:person',
  'entity:merchant',
  'entity:place',
  'dedupe-dismissed'
] as const
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number]

/**
 * Load the targets for the given kinds into one Set. Callers that need kinds kept
 * apart call this once per kind; the common case (upsertContacts skipping both
 * tombstoned AND merged external ids) wants the union.
 */
export function loadExclusionSet(db: Db, kinds: ExclusionKind[]): Set<string> {
  try {
    const rows = db
      .select({ target: curationExclusions.target })
      .from(curationExclusions)
      .where(inArray(curationExclusions.kind, kinds))
      .all()
    return new Set(rows.map((r) => r.target))
  } catch {
    return new Set() // table absent (mid-upgrade) → no exclusions
  }
}

/** Idempotently record exclusions. Re-excluding is a no-op via the unique index. */
export function addExclusions(db: Db, kind: ExclusionKind, targets: string[]): void {
  for (const target of targets) {
    const t = target?.trim()
    if (!t) continue
    try {
      db.insert(curationExclusions).values({ kind, target: t }).onConflictDoNothing().run()
    } catch {
      /* table absent (mid-upgrade) — same graceful posture as the loaders */
    }
  }
}

/** Remove one exclusion (e.g. promote clearing its own tombstone). */
export function removeExclusion(db: Db, kind: ExclusionKind, target: string): void {
  try {
    db.delete(curationExclusions)
      .where(and(eq(curationExclusions.kind, kind), eq(curationExclusions.target, target)))
      .run()
  } catch {
    /* table absent → nothing to remove */
  }
}

/** Clear a whole kind (the Settings "Clear" action). Returns how many were removed. */
export function clearExclusions(db: Db, kind: ExclusionKind): number {
  try {
    const before = db
      .select({ target: curationExclusions.target })
      .from(curationExclusions)
      .where(eq(curationExclusions.kind, kind))
      .all().length
    db.delete(curationExclusions).where(eq(curationExclusions.kind, kind)).run()
    return before
  } catch {
    return 0
  }
}

/** Per-kind counts for the Settings surface. Absent kinds are simply missing. */
export function countExclusions(db: Db): Record<string, number> {
  const counts: Record<string, number> = {}
  try {
    const rows = db.select({ kind: curationExclusions.kind }).from(curationExclusions).all()
    for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  } catch {
    /* table absent → empty counts */
  }
  return counts
}
