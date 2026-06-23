/**
 * CRED engine IPC (Phase 10.6a) — the Portal Automation Sandbox surface.
 *
 * Mode A only: assisted login, NO stored credentials. `cred:run` opens a
 * sandboxed window for a portal, the user logs in themselves, Compass drives the
 * download, and the artifact re-enters through the SAME `ingestFiles` pipeline
 * as a manual drop. No secret ever crosses this boundary.
 *
 * The window-driving runner is injected (`deps.runPull`) so the validation /
 * dispatch / cancel logic here is unit-testable without a real BrowserWindow;
 * production wires the integration-only runner from `integrations/cred/window`.
 */

import { rmSync } from 'node:fs'
import type { IpcMain } from 'electron'
import { CRED_ADAPTERS, getAdapter } from '../integrations/cred/adapters'
import type { CredRunResult } from '../integrations/cred/types'
import { runPull as productionRunPull } from '../integrations/cred/window'
import { ingestFiles } from './records'

type ActivePull = { close: () => void }

export interface CredDeps {
  runPull: (
    portalId: string,
    register: (active: ActivePull) => void
  ) => Promise<{ ok: boolean; cancelled?: boolean; path?: string; error?: string }>
  ingest: (paths: string[]) => Promise<{ imported: number; duplicates: number }>
}

const DEFAULT_DEPS: CredDeps = { runPull: productionRunPull, ingest: ingestFiles }

/**
 * Portal automation is OFF by default and opt-in via `COMPASS_ENABLE_CRED=1`.
 * It ships disabled while the first adapter (SSA) is still `beta` and unvalidated
 * against a live account — so a release never surfaces a broken "Automate this
 * pull" button. Validation runs in a dev build with the flag set; a user-facing
 * Settings toggle lands once an adapter is proven. The gate is enforced on BOTH
 * `cred:list` (so the UI hides the affordance) and `cred:run` (defense in depth).
 */
function isCredEnabled(): boolean {
  return process.env.COMPASS_ENABLE_CRED === '1'
}

export function registerCredHandlers(ipcMain: IpcMain, deps: CredDeps = DEFAULT_DEPS): void {
  // Only one assisted pull at a time (one visible window the user is driving).
  let active: ActivePull | null = null

  // The portals Compass can automate — safe metadata only, never a credential.
  // Empty until automation is enabled, so the UI shows no "Automate" affordance.
  ipcMain.handle('cred:list', () =>
    isCredEnabled() ? CRED_ADAPTERS.map((a) => ({ id: a.id, name: a.name, status: a.status })) : []
  )

  // Open the assisted-login window for one portal, then ingest what it returns.
  ipcMain.handle('cred:run', async (_event, portalId: unknown): Promise<CredRunResult> => {
    if (!isCredEnabled()) {
      return { ok: false, error: 'Portal automation is disabled' }
    }
    if (typeof portalId !== 'string' || !getAdapter(portalId)) {
      return { ok: false, error: 'Unknown portal' }
    }
    if (active) return { ok: false, error: 'A data pull is already in progress' }

    try {
      const outcome = await deps.runPull(portalId, (a) => {
        active = a
      })
      if (!outcome.ok || !outcome.path) {
        return { ok: false, cancelled: outcome.cancelled, error: outcome.error }
      }
      const path = outcome.path
      try {
        const res = await deps.ingest([path])
        return { ok: true, imported: res.imported, duplicates: res.duplicates }
      } finally {
        // The data now lives in `records`; don't leave the fetched artifact (which
        // may hold sensitive content, e.g. an SSA statement) sitting in temp.
        try {
          rmSync(path, { force: true })
        } catch {
          /* best-effort cleanup */
        }

        // Best-effort cleanup of the per-run temp dir created by the runner.
        const dir = path.replace(/[/\\][^/\\]+$/, '')
        const leaf = dir.split(/[/\\]/).pop() ?? ''
        if (leaf.startsWith('compass-cred-')) {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      active = null
    }
  })

  // Tear down the in-flight window (the user can also just close it themselves).
  ipcMain.handle('cred:cancel', () => {
    active?.close()
    active = null
    return { ok: true }
  })
}
