/**
 * Crash-atomic replacement of the whole `.vault/` directory, used by backup
 * restore.
 *
 * Writing restored blobs into the live vault one by one leaves a window where
 * a failure (or crash) strands blobs with no `key.enc`. The next
 * `getOrCreateKey()` then mints a NEW key and every restored blob is
 * orphaned. Instead the complete new vault — `key.enc` included — is written
 * into a sibling staging dir and swapped in with two renames:
 *
 *   1. write everything into `.vault.restore-staging/`
 *   2. rename `.vault/`                  → `.vault.restore-old/`
 *   3. rename `.vault.restore-staging/`  → `.vault/`
 *   4. delete `.vault.restore-old/`
 *
 * Invariant: staging is only ever written while `.vault/` exists, so if
 * `.vault/` is missing, the staging dir (when present) is complete. A crash
 * between steps 2 and 3 is repaired by `recoverInterruptedVaultSwap`, which
 * runs at startup before `.vault/` is (re)created.
 *
 * Power loss can still lose un-fsynced data, as with every other write path
 * in the app; this guards against process death and thrown errors.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { VAULT_DIR } from '../paths'

const STAGING_DIR = `${VAULT_DIR}.restore-staging`
const OLD_DIR = `${VAULT_DIR}.restore-old`

function rmQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort; the next recovery pass retries */
  }
}

/**
 * Finish or undo a vault swap that a crash interrupted, and clear leftovers.
 * Must run before anything creates `.vault/` (or a fresh key.enc) at startup.
 *
 *   - `.vault/` missing + staging present → the crash hit between the two
 *     renames; staging is complete (see invariant) and matches the DB the
 *     restore already committed, so promote it.
 *   - `.vault/` missing + only the old dir → put the old vault back.
 *   - `.vault/` present → any staging dir is partial and any old dir is
 *     superseded; delete both.
 *
 * Throws if a needed rename fails, leaving `.vault/` absent: `getOrCreateKey`
 * then fails (no dir to create key.enc in) instead of minting a new key.
 */
export function recoverInterruptedVaultSwap(): void {
  if (!existsSync(VAULT_DIR)) {
    if (existsSync(STAGING_DIR)) renameSync(STAGING_DIR, VAULT_DIR)
    else if (existsSync(OLD_DIR)) renameSync(OLD_DIR, VAULT_DIR)
  }
  rmQuiet(STAGING_DIR)
  rmQuiet(OLD_DIR)
}

/** Vault-namespace check, case-insensitive: macOS (APFS) and Windows treat
 *  `KEY.enc` and `key.enc` as the same file. */
function isEncEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.enc') || lower.endsWith('.enc.tmp')
}

/** True for any casing of `key.enc`. */
export function isMasterKeyName(name: string): boolean {
  return name.toLowerCase() === 'key.enc'
}

/**
 * Replace every `.enc` in the vault with `blobs` plus `key.enc` (already
 * wrapped with this machine's safeStorage). Everything else in the current
 * vault — files, directories, symlinks (copied as links, never followed) —
 * is carried over. Fully synchronous, so no other vault reader or writer in
 * this process can observe an intermediate state.
 *
 * On a thrown error the previous vault is left in place (or, if even the
 * rollback rename fails, restorable by `recoverInterruptedVaultSwap`). Never
 * leaves blobs without their key.enc.
 */
export function swapInVault(wrappedKey: Buffer, blobs: ReadonlyArray<[string, Buffer]>): void {
  recoverInterruptedVaultSwap()
  mkdirSync(VAULT_DIR, { recursive: true })

  try {
    mkdirSync(STAGING_DIR, { mode: statSync(VAULT_DIR).mode & 0o777 })
    for (const [name, bytes] of blobs) {
      if (isMasterKeyName(name)) continue
      writeFileSync(join(STAGING_DIR, name), bytes)
    }
    for (const name of readdirSync(VAULT_DIR)) {
      if (isEncEntry(name)) continue
      cpSync(join(VAULT_DIR, name), join(STAGING_DIR, name), {
        recursive: true,
        verbatimSymlinks: true
      })
    }
    // key.enc LAST, so nothing written above can replace it — on a
    // case-insensitive filesystem a `KEY.enc` blob is the same file.
    writeFileSync(join(STAGING_DIR, 'key.enc'), wrappedKey)
  } catch (err) {
    rmQuiet(STAGING_DIR)
    throw err
  }

  try {
    renameSync(VAULT_DIR, OLD_DIR)
  } catch (err) {
    rmQuiet(STAGING_DIR)
    throw err
  }

  try {
    renameSync(STAGING_DIR, VAULT_DIR)
  } catch (err) {
    try {
      renameSync(OLD_DIR, VAULT_DIR)
      rmQuiet(STAGING_DIR)
    } catch {
      // Both renames failed: .vault/ is absent and the complete staging dir
      // is still there. Leave it for recoverInterruptedVaultSwap; with no
      // .vault/ dir, getOrCreateKey can't mint a replacement key meanwhile.
    }
    throw err
  }

  rmQuiet(OLD_DIR)
}
