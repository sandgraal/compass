/**
 * One-shot retirement of the `<category>.migrated.enc` vault backups left by
 * the vault → life-records split (electron/integrations/vault-life-migration.ts).
 *
 * The split renamed each processed legacy blob instead of deleting it, "for a
 * release or two" of safety margin — no reader ever touched them and no
 * restore path exists. Two releases (1.11, 1.12) have shipped since, so this
 * pass deletes them for good. Note they are the only remaining copy of the
 * dropped `_history` arrays and stray keys — that is the point of retirement,
 * not an accident.
 *
 * Lives in its own dependency-light module (fs + the one-shot gate only) so
 * `DB_INIT_REPAIRS` in electron/db/client.ts can import it without pulling in
 * the migration's crypto/Keychain stack or creating an import cycle
 * (vault-life-migration imports db/client).
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_DIR } from '../paths'
import { LIFE_CATEGORY_IDS } from './life-records'
import { type SqliteForOneShot, runOnceGated } from './one-shot-repair'

/** Must match VAULT_LIFE_MIGRATION_KEY in vault-life-migration.ts (not
 *  imported — that module drags in crypto-vault/electron). */
const VAULT_LIFE_MIGRATION_KEY = 'vaultLifeRecordsMigrated'

export const MIGRATED_BLOBS_RETIRE_KEY = 'vaultMigratedBlobsRetired'

/**
 * Delete the migrated-blob backups once, only after the migration itself has
 * committed. On a fresh upgrade the DB-init repairs run BEFORE main.ts's
 * deferred migration block, so the first boot skips (without consuming the
 * gate) and the retirement lands on the next one.
 */
export function retireMigratedVaultBlobsIfNeeded(
  sqlite: SqliteForOneShot
): { ran: false } | { ran: true; removed: number } {
  const migrated = sqlite
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(VAULT_LIFE_MIGRATION_KEY)
  if (!migrated) return { ran: false }
  return runOnceGated(sqlite, MIGRATED_BLOBS_RETIRE_KEY, () => {
    let removed = 0
    for (const category of LIFE_CATEGORY_IDS) {
      const path = join(VAULT_DIR, `${category}.migrated.enc`)
      if (existsSync(path)) {
        rmSync(path)
        removed++
      }
    }
    return { removed }
  })
}
