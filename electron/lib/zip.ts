/**
 * Safe streaming ZIP reader for the Drop Zone (Phase 10.4 — Google Takeout).
 *
 * Wraps `yauzl` to walk an archive ONE ENTRY AT A TIME without loading it into
 * memory (essential for multi-GB Takeouts). Each ingestable entry is streamed to a
 * private temp file, handed to `onEntry`, then deleted — so the rest of the ingest
 * pipeline treats a zip's contents exactly like dropped files.
 *
 * Hardened against:
 *   - zip-bombs — entry-count + total-uncompressed-byte caps, per-entry size cap;
 *   - zip-slip  — entries extract to OUR generated temp names; the archive's own
 *                 paths are never used on disk (only `basename` is, for naming).
 * Non-ingestable extensions (photos/videos/binaries) are skipped before extraction.
 */

import { createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import yauzl from 'yauzl'

const INGESTABLE = new Set(['csv', 'json', 'xml', 'mbox', 'txt', 'html', 'htm'])
const MAX_ZIP_ENTRIES = 5000
const MAX_ZIP_TOTAL = 5 * 1024 ** 3 // 5 GB uncompressed across the archive (zip-bomb guard)
const MAX_ENTRY_BYTES = 2 * 1024 ** 3 // per-entry uncompressed cap

export interface ZipResult {
  skipped: string[]
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('zip: open failed'))
      else resolve(zip)
    })
  })
}

function extractEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('zip: read stream failed'))
      const ws = createWriteStream(dest)
      stream.on('error', reject)
      ws.on('error', reject)
      ws.on('close', resolve)
      stream.pipe(ws)
    })
  })
}

/**
 * Walk a zip, extracting each ingestable entry to a temp file and awaiting
 * `onEntry(name, tmpPath)` for it. Returns the names that were skipped.
 */
export async function forEachZipEntry(
  zipPath: string,
  onEntry: (entryName: string, tmpPath: string) => Promise<void>
): Promise<ZipResult> {
  const skipped: string[] = []
  const tmpDir = mkdtempSync(join(tmpdir(), 'compass-zip-'))
  let count = 0
  let total = 0
  const zip = await openZip(zipPath)

  try {
    await new Promise<void>((resolve, reject) => {
      zip.readEntry()
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          try {
            const name = entry.fileName
            const ext = extname(name).slice(1).toLowerCase()
            if (name.endsWith('/')) {
              // directory — nothing to do
            } else if (!INGESTABLE.has(ext)) {
              skipped.push(basename(name))
            } else if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
              skipped.push(`${basename(name)} (too large)`)
            } else if (count >= MAX_ZIP_ENTRIES || total + entry.uncompressedSize > MAX_ZIP_TOTAL) {
              skipped.push(`${basename(name)} (archive limit)`)
            } else {
              count++
              total += entry.uncompressedSize
              const tmpPath = join(tmpDir, `${count}-${basename(name)}`)
              await extractEntry(zip, entry, tmpPath)
              try {
                await onEntry(basename(name), tmpPath)
              } finally {
                rmSync(tmpPath, { force: true })
              }
            }
            zip.readEntry() // advance to the next entry only after this one is done
          } catch (err) {
            reject(err)
          }
        })()
      })
      zip.on('end', resolve)
      zip.on('error', reject)
    })
  } finally {
    zip.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  return { skipped }
}
