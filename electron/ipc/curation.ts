/**
 * Curation IPC — the Settings surface over `curation_exclusions` (the durable
 * "no" list: tombstoned contacts, dedupe merge losers, "not interested"
 * entities, dismissed duplicate pairs).
 *
 * `curation:counts` powers the "N blocked / hidden — Clear" rows;
 * `curation:clear` empties ONE kind (validated against the known list — clearing
 * `contact-tombstone` lets blocked contacts re-import on the next sync; clearing
 * an `entity:*` kind triggers a derived-entities refresh so hidden rows reappear
 * immediately). Renderer-only; never exposed as an assistant/MCP tool.
 */
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import {
  EXCLUSION_KINDS,
  type ExclusionKind,
  clearExclusions,
  countExclusions
} from '../lib/curation'

export function registerCurationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('curation:counts', (): Record<string, number> => countExclusions(getDb()))

  ipcMain.handle('curation:clear', async (_event, kind: string) => {
    if (!EXCLUSION_KINDS.includes(kind as ExclusionKind)) {
      throw new Error(`curation:clear: unknown kind ${String(kind)}`)
    }
    const cleared = clearExclusions(getDb(), kind as ExclusionKind)
    // Un-hiding entities only takes effect in the derived cache after a rebuild.
    if (kind.startsWith('entity:') && cleared > 0) {
      try {
        const { refreshDerivedEntities } = await import('../lib/entities-projection')
        refreshDerivedEntities(getDb())
      } catch {
        /* best-effort — the next sync rebuilds anyway */
      }
    }
    return { success: true, cleared }
  })
}
