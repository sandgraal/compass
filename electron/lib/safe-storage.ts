/**
 * Thin wrapper over Electron's async `safeStorage` API (the sync
 * `isEncryptionAvailable` / `encryptString` / `decryptString` trio is
 * deprecated in Electron 45 and removed in 46).
 *
 * Ciphertext written by the old sync `encryptString` decrypts unchanged via
 * `decryptStringAsync`, so existing `.vault/key.enc` and token files keep
 * working without a migration step.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'

/** Throws unless the OS-backed async encryptor is usable. `what` names the caller in the error. */
export async function assertSafeStorageAvailable(what: string): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error(`safeStorage unavailable — cannot encrypt ${what} on this machine`)
  }
}

/** Encrypt `plaintext` with the OS-backed key. Refuses when safeStorage is unavailable. */
export async function safeEncrypt(plaintext: string, what: string): Promise<Buffer> {
  await assertSafeStorageAvailable(what)
  return safeStorage.encryptStringAsync(plaintext)
}

/**
 * Read and decrypt a safeStorage blob from `path`. When Electron reports
 * `shouldReEncrypt` (the OS key or encryption provider changed since the blob
 * was written), the file is re-encrypted under the current key via an atomic
 * tmp-file + rename so a crash can't truncate it. Re-encryption is
 * best-effort: on failure the original file is left as-is (it still
 * decrypts) and the plaintext is returned.
 *
 * The rename only happens if the file is still byte-identical to what was
 * decrypted. A concurrent writer (backup restore, token save/delete) may have
 * replaced or removed it during the encrypt await; renaming over that would
 * resurrect stale contents. The compare + rename are synchronous, so nothing
 * can slip in between them.
 */
export async function decryptFileWithStatus(path: string): Promise<{
  result: string
  /** Bytes decrypted. */
  original: Buffer
  /** Bytes this call wrote back (re-encryption), or null if it wrote nothing. */
  rewrittenTo: Buffer | null
}> {
  const original = readFileSync(path)
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(original)
  let rewrittenTo: Buffer | null = null
  if (shouldReEncrypt) {
    const tmpPath = `${path}.tmp`
    try {
      const fresh = await safeStorage.encryptStringAsync(result)
      if (existsSync(path) && readFileSync(path).equals(original)) {
        writeFileSync(tmpPath, fresh)
        renameSync(tmpPath, path)
        rewrittenTo = fresh
      }
    } catch {
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
  }
  return { result, original, rewrittenTo }
}

/** `decryptFileWithStatus`, returning only the plaintext. */
export async function decryptFile(path: string): Promise<string> {
  return (await decryptFileWithStatus(path)).result
}
