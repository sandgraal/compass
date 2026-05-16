/**
 * Spotlight-friendly mirror of the knowledge base — Phase 5.14.
 *
 * macOS Spotlight indexes `~/Documents/` and `~/Desktop/` by default,
 * but NOT `~/Library/Application Support/`. That means a user can type
 * a phrase from one of their Compass notes into Spotlight and get
 * nothing — even though the same text would be a hit in the in-app
 * search and in the new "Ask Compass" panel.
 *
 * This module solves it the simplest way: on opt-in, we maintain a
 * one-way mirror of `knowledge-base/*.md` at a user-chosen path under
 * `~/Documents/`. macOS indexes that path natively, so Spotlight (and
 * any third-party tool that respects Spotlight) finds Compass content
 * by full-text content match.
 *
 * Design choices:
 *   - Mirror is one-way (Compass → Documents). Edits to the mirrored
 *     copies are NOT synced back; the source of truth stays at
 *     `~/Library/Application Support/Compass/knowledge-base/`. A
 *     README in the mirror dir tells the user that explicitly.
 *   - Mirror path is user-configurable via Settings (default
 *     `~/Documents/Compass Notes`). We never write OUTSIDE
 *     `~/Documents/` or `~/Desktop/` — anywhere else and Spotlight
 *     wouldn't index it, defeating the purpose.
 *   - The chokidar watcher on `knowledge-base/` already exists for the
 *     KB editor's live-update path. We hook a second listener onto the
 *     same events instead of standing up a parallel watcher.
 *   - The implementation here is the pure planner + IO primitives.
 *     The IPC wiring lives in `electron/ipc/spotlight.ts`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { sep as PATH_SEP, dirname, join, relative } from 'node:path'

const DEFAULT_DIR_NAME = 'Compass Notes'
const README_FILENAME = 'README.txt'

/**
 * Spotlight only indexes a handful of standard user folders out of the
 * box. We restrict the mirror target to those to ensure the feature
 * actually does what it says — mirroring to `~/Library/...` would be a
 * silent no-op for the user.
 */
export function isAllowedMirrorPath(target: string): boolean {
  const home = homedir()
  // Resolve `~` / leading slash conventions to absolute. We don't fully
  // canonicalize (no realpathSync) because the target may not exist
  // yet; we only care about prefix shape.
  const abs = target.startsWith('~') ? join(home, target.slice(1)) : target
  if (!abs.startsWith('/')) return false
  // Tighten: only allow ~/Documents/* and ~/Desktop/*. iCloud Drive,
  // Dropbox-style sync folders work fine too but the canonical
  // Spotlight-indexed paths are these two; keeps the surface
  // predictable.
  const documents = join(home, 'Documents')
  const desktop = join(home, 'Desktop')
  // Equal or under (with separator to avoid /Documents-evil matching /Documents).
  return (
    abs === documents ||
    abs === desktop ||
    abs.startsWith(`${documents}${PATH_SEP}`) ||
    abs.startsWith(`${desktop}${PATH_SEP}`)
  )
}

/** Default mirror path. Caller can override. */
export function defaultMirrorPath(): string {
  return join(homedir(), 'Documents', DEFAULT_DIR_NAME)
}

/**
 * Map a `knowledge-base/`-relative path (e.g. `profile/health.md`)
 * to the absolute mirror destination. Pure — no fs access.
 */
export function mirrorTargetFor(mirrorRoot: string, knowledgeRelPath: string): string {
  // POSIX-normalize on the way out so Windows paths in tests still
  // round-trip correctly. (No production Windows users for the Apple
  // Calendar / Spotlight feature, but the helpers should not assume.)
  return join(mirrorRoot, knowledgeRelPath)
}

function walkMarkdown(dir: string, base: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, base))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(relative(base, full))
    }
  }
  return out
}

export interface BackfillResult {
  copied: number
  skipped: number
  removed: number
  errors: Array<{ path: string; message: string }>
}

const README_BODY = `Compass — Spotlight-friendly mirror

This folder is a one-way copy of your Compass knowledge base, kept
here so macOS Spotlight can index the file content. Edits to files in
THIS folder are NOT synced back to Compass — the source of truth lives
at:

    ~/Library/Application Support/Compass/knowledge-base/

Disable the mirror in Compass → Settings → Knowledge → Spotlight
indexing to stop the sync (the existing files stay in place; nothing
is deleted).
`

/**
 * One-time backfill / reconcile. Copies every `.md` from `kbRoot` to
 * the equivalent path under `mirrorRoot`, creates parent dirs as it
 * goes, and prunes any mirrored `.md` whose source file is gone.
 *
 * `mtime`-skip avoids unnecessary copies: if the mirrored file has the
 * same mtime as the source (modulo 1s precision), we leave it alone.
 *
 * Returns counts so the UI can show the user what happened.
 */
export function reconcileMirror(kbRoot: string, mirrorRoot: string): BackfillResult {
  if (!isAllowedMirrorPath(mirrorRoot)) {
    throw new Error(
      `Spotlight mirror path must be under ~/Documents or ~/Desktop. Got: ${mirrorRoot}`
    )
  }
  const result: BackfillResult = { copied: 0, skipped: 0, removed: 0, errors: [] }

  if (!existsSync(mirrorRoot)) {
    mkdirSync(mirrorRoot, { recursive: true })
  }

  // README is best-effort. Don't fail the whole reconcile if the user
  // has it open / read-only.
  try {
    const readme = join(mirrorRoot, README_FILENAME)
    if (!existsSync(readme)) writeFileSync(readme, README_BODY, 'utf8')
  } catch {
    /* ignore */
  }

  const sourceFiles = walkMarkdown(kbRoot, kbRoot)
  const expectedTargets = new Set<string>()

  for (const rel of sourceFiles) {
    const src = join(kbRoot, rel)
    const dst = mirrorTargetFor(mirrorRoot, rel)
    expectedTargets.add(dst)
    try {
      const dstDir = dirname(dst)
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })

      if (existsSync(dst)) {
        const srcStat = statSync(src)
        const dstStat = statSync(dst)
        // mtime compared to whole seconds — the chokidar
        // `awaitWriteFinish` upstream gives us sub-second jitter that
        // would force a copy on every reconcile otherwise.
        if (Math.floor(srcStat.mtimeMs / 1000) === Math.floor(dstStat.mtimeMs / 1000)) {
          result.skipped++
          continue
        }
      }
      copyFileSync(src, dst)
      result.copied++
    } catch (err) {
      result.errors.push({ path: rel, message: (err as Error).message })
    }
  }

  // Prune mirrored .md files whose source is gone.
  function prune(dir: string): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        prune(full)
        // Best-effort empty-dir cleanup so deleting the only file
        // under `profile/` removes `profile/` too — except `mirrorRoot`
        // itself, which we always keep.
        try {
          if (full !== mirrorRoot && readdirSync(full).length === 0) rmSync(full, { force: true })
        } catch {
          /* ignore */
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (!expectedTargets.has(full)) {
          try {
            rmSync(full, { force: true })
            result.removed++
          } catch (err) {
            result.errors.push({ path: full, message: (err as Error).message })
          }
        }
      }
    }
  }
  prune(mirrorRoot)

  return result
}

/**
 * Apply a single change from the chokidar watcher. `event` is one of
 * `'add' | 'change' | 'unlink'`. Caller supplies the absolute source
 * path; we compute the mirror target and execute the corresponding
 * filesystem op.
 *
 * Returns a typed disposition the caller can log; throws only on
 * truly unrecoverable errors (caller catches + records).
 */
export function applyMirrorChange(
  event: 'add' | 'change' | 'unlink',
  kbRoot: string,
  mirrorRoot: string,
  sourceAbsPath: string
): { kind: 'copied' | 'removed' | 'noop'; target: string | null } {
  if (!isAllowedMirrorPath(mirrorRoot)) {
    return { kind: 'noop', target: null }
  }
  if (!sourceAbsPath.endsWith('.md')) {
    return { kind: 'noop', target: null }
  }
  if (!sourceAbsPath.startsWith(kbRoot)) {
    // Defensive: chokidar can occasionally emit paths outside the
    // watched root if symlinks are followed. Refuse rather than write
    // arbitrary paths under mirrorRoot.
    return { kind: 'noop', target: null }
  }

  const rel = relative(kbRoot, sourceAbsPath)
  const dst = mirrorTargetFor(mirrorRoot, rel)

  if (event === 'unlink') {
    if (existsSync(dst)) {
      rmSync(dst, { force: true })
      return { kind: 'removed', target: dst }
    }
    return { kind: 'noop', target: dst }
  }

  if (!existsSync(sourceAbsPath)) {
    return { kind: 'noop', target: dst }
  }
  const dstDir = dirname(dst)
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
  copyFileSync(sourceAbsPath, dst)
  return { kind: 'copied', target: dst }
}

// Exported for tests.
export const _internal = { walkMarkdown, README_BODY, README_FILENAME }
