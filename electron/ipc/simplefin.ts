/**
 * IPC surface for SimpleFIN Bridge (Phase 4.7).
 *
 * SimpleFIN is the local-first-friendly counterpart to Plaid: the USER signs up
 * with SimpleFIN Bridge, links their own banks, and pastes a one-time base64
 * Setup Token. There is no developer client_id/secret, no OAuth Link window —
 * just a token claim. Four calls:
 *
 *  - `simplefin:get-status`        → { connectionIds }
 *  - `simplefin:claim-token`       → claim the Setup Token → store Access URL in
 *                                    the vault → create the connection row →
 *                                    run a first sync. Returns connection
 *                                    metadata; NEVER the Access URL.
 *  - `simplefin:list-connections`  → connection summaries for the card.
 *  - `simplefin:disconnect`        → tombstone the vault entry, unlink owned
 *                                    accounts, delete the connection row.
 *
 * The Access URL embeds HTTP Basic credentials and lives only in
 * `.vault/simplefin.enc` — it is never returned to the renderer.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { financeAccounts, integrations, simplefinConnections } from '../db/schema'
import { claimSetupToken, fetchAccounts } from '../integrations/simplefin/client'
import { syncSimplefin } from '../integrations/simplefin/sync'
import { listConnectionIds, removeAccessUrl, setAccessUrl } from '../integrations/simplefin/vault'

export type SimplefinStatus = {
  /** Connection ids that have an Access URL stored in the vault. */
  connectionIds: string[]
}

/** Per-connection summary for the Integrations card. No URLs, no credentials. */
export type SimplefinConnectionSummary = {
  id: number
  connectionId: string
  orgName: string
  orgDomain: string | null
  lastSyncedAt: number | null
  errorCode: string | null
}

export type SimplefinClaimResult = {
  ok: true
  connectionId: string
  orgName: string
  added: number
  accountsUpserted: number
  accountsLinked: number
}

export function registerSimplefinHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'simplefin:get-status',
    (): SimplefinStatus => ({
      connectionIds: listConnectionIds()
    })
  )

  ipcMain.handle(
    'simplefin:claim-token',
    async (_e, setupToken: unknown): Promise<SimplefinClaimResult> => {
      if (typeof setupToken !== 'string' || setupToken.trim().length === 0) {
        throw new Error('simplefin:claim-token: setupToken must be a non-empty string')
      }

      // Claim first — this validates the token and yields the Access URL.
      const { accessUrl } = await claimSetupToken(setupToken)
      const connectionId = randomUUID()
      // Vault before DB: the credential is the irrecoverable thing. A crash after
      // this but before the row write leaves a dangling vault entry the user can
      // re-claim over, which is strictly safer than a row with no credential.
      setAccessUrl(connectionId, accessUrl)

      // Probe once for org metadata (display only). Non-fatal.
      let orgName = ''
      let orgDomain: string | null = null
      try {
        const now = Math.floor(Date.now() / 1000)
        const probe = await fetchAccounts(accessUrl, { startDate: now - 30 * 86_400, endDate: now })
        const org = probe.accounts[0]?.org
        orgName = org?.name ?? ''
        orgDomain = org?.domain ?? null
      } catch {
        // Metadata only — a probe failure shouldn't block the connection.
      }

      const db = getDb()
      // Ensure an integrations row exists (for sync_events FK + status + the
      // Integrations card). syncIntervalMinutes=0 → not driven by the generic
      // interval cron; SimpleFIN uses its own daily schedule (cron-simplefin.ts).
      db.insert(integrations)
        .values({
          service: 'simplefin',
          status: 'connected',
          connectedAt: new Date(),
          syncIntervalMinutes: 0
        })
        .onConflictDoUpdate({ target: integrations.service, set: { status: 'connected' } })
        .run()
      db.insert(simplefinConnections)
        .values({ connectionId, orgName, orgDomain })
        .onConflictDoNothing()
        .run()

      // Kick off a first sync so accounts + transactions appear immediately.
      // Failures are surfaced via sync_events; they don't fail the claim (the
      // connection is valid and the daily cron will retry).
      let added = 0
      let accountsUpserted = 0
      let accountsLinked = 0
      try {
        const result = await syncSimplefin(connectionId)
        added = result.added
        accountsUpserted = result.accountsUpserted
        accountsLinked = result.accountsLinked
      } catch {
        // non-fatal
      }

      return { ok: true, connectionId, orgName, added, accountsUpserted, accountsLinked }
    }
  )

  ipcMain.handle('simplefin:list-connections', (): SimplefinConnectionSummary[] => {
    const rows = getDb()
      .select({
        id: simplefinConnections.id,
        connectionId: simplefinConnections.connectionId,
        orgName: simplefinConnections.orgName,
        orgDomain: simplefinConnections.orgDomain,
        lastSyncedAt: simplefinConnections.lastSyncedAt,
        errorCode: simplefinConnections.errorCode
      })
      .from(simplefinConnections)
      .all()
    return rows.map((r) => ({
      ...r,
      // Serialize Date → epoch ms; the preload bridge can't ship Date objects.
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.getTime() : null
    }))
  })

  ipcMain.handle('simplefin:disconnect', (_e, connectionId: unknown): { ok: true } => {
    if (typeof connectionId !== 'string' || connectionId.length === 0) {
      throw new Error('simplefin:disconnect: connectionId must be a non-empty string')
    }
    // Tombstone the credential first.
    removeAccessUrl(connectionId)

    const db = getDb()
    const row = db
      .select({ id: simplefinConnections.id })
      .from(simplefinConnections)
      .where(eq(simplefinConnections.connectionId, connectionId))
      .get()
    if (row) {
      // Sever the live link on owned accounts BEFORE deleting the connection
      // row — foreign_keys is ON, so a dangling FK would otherwise block the
      // delete. We keep the accounts + their transaction history (local-first:
      // disconnecting a source never destroys the user's data); they simply
      // revert to manual/unlinked accounts.
      db.update(financeAccounts)
        .set({ simplefinConnectionId: null })
        .where(eq(financeAccounts.simplefinConnectionId, row.id))
        .run()
      db.delete(simplefinConnections).where(eq(simplefinConnections.id, row.id)).run()
    }
    return { ok: true }
  })
}
