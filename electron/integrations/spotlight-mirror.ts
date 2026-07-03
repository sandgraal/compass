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
 *   - The mirror runs its own chokidar watcher (started by
 *     `electron/ipc/spotlight.ts`). We don't piggy-back on the
 *     existing KB editor watcher — that one's lifecycle is tied to a
 *     specific BrowserWindow and we need the mirror to keep working
 *     while the renderer is mid-reload. Two watchers on the same dir
 *     is fine: chokidar dedupes nothing for us but the OS-level
 *     FSEvents subscription is shared.
 *   - The implementation here is the pure planner + IO primitives.
 *     The IPC wiring lives in `electron/ipc/spotlight.ts`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { sep as PATH_SEP, dirname, join, resolve as pathResolve, relative } from 'node:path'

const DEFAULT_DIR_NAME = 'Compass Notes'
const README_FILENAME = 'README.txt'

/**
 * Resolve a user-provided path string to an absolute path WITHOUT
 * touching the filesystem (target may not exist yet). Handles `~`
 * expansion and `..` segments — the latter is the security-critical
 * part: a raw-string prefix check on `~/Documents/../Library/...`
 * would happily pass even though the filesystem call resolves the
 * `..` and escapes the allowlist. `path.resolve` collapses those.
 */
function resolveTarget(target: string): string {
  const home = homedir()
  const expanded = target.startsWith('~') ? join(home, target.slice(1)) : target
  return pathResolve(expanded)
}

/**
 * Spotlight only indexes a handful of standard user folders out of the
 * box. We restrict the mirror target to those to ensure the feature
 * actually does what it says — mirroring to `~/Library/...` would be a
 * silent no-op for the user.
 *
 * Two additional safety constraints beyond "must be Spotlight-indexed":
 *
 *   1. **No bare roots.** `~/Documents` and `~/Desktop` themselves are
 *      rejected. If we accepted them, the prune pass would treat the
 *      entire folder as Compass-owned and recursively delete every
 *      `.md` not in the knowledge base — wiping the user's other
 *      Markdown notes. Must be a dedicated SUB-directory.
 *
 *   2. **Normalize before compare.** `~/Documents/../Library/...`
 *      passes a raw-string prefix check but the filesystem call would
 *      escape the allowlist. We `path.resolve` first so `..` collapses
 *      before the prefix match.
 */
export function isAllowedMirrorPath(target: string): boolean {
  if (typeof target !== 'string' || target.length === 0) return false
  const home = homedir()
  const abs = resolveTarget(target)
  if (!abs.startsWith('/')) return false
  const documents = pathResolve(join(home, 'Documents'))
  const desktop = pathResolve(join(home, 'Desktop'))
  // Reject the bare root — must be a dedicated subdirectory so the
  // prune pass can't reach the user's unrelated files.
  if (abs === documents || abs === desktop) return false
  // Equal-or-under with separator boundary so `~/Documents-evil`
  // can't match `~/Documents`.
  return abs.startsWith(`${documents}${PATH_SEP}`) || abs.startsWith(`${desktop}${PATH_SEP}`)
}

/**
 * Returns the normalized absolute path for a user-supplied target,
 * iff it passes `isAllowedMirrorPath`. Centralised here so the IPC
 * layer and the reconcile/apply paths all agree on the same shape.
 */
export function normalizedMirrorPath(target: string): string | null {
  if (!isAllowedMirrorPath(target)) return null
  return resolveTarget(target)
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

/**
 * True iff the mirror at `dst` is already byte-for-byte identical to the
 * source (`src`, whose size the caller already stat'd as `srcSize`). Size
 * is the cheap gate; only when sizes tie do we read both files.
 *
 * A failure to read the DESTINATION (it exists but is unreadable — odd
 * permissions/ACLs, or it vanished between the stat and the read) is
 * treated as "not identical" so the caller re-copies rather than
 * recording an error: overwriting an unreadable mirror file can still
 * succeed. A failure to read the SOURCE is a real problem (we couldn't
 * copy it either) and propagates to the caller's error handler.
 */
function mirrorMatchesSource(src: string, srcSize: number, dst: string): boolean {
  let dstSize: number
  try {
    dstSize = statSync(dst).size
  } catch {
    return false
  }
  if (srcSize !== dstSize) return false
  const srcBuf = readFileSync(src)
  let dstBuf: Buffer
  try {
    dstBuf = readFileSync(dst)
  } catch {
    return false
  }
  return srcBuf.equals(dstBuf)
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

Disable the mirror in Compass → Settings → Data → Spotlight indexing
to stop the sync (the existing files stay in place; nothing is
deleted).
`

/**
 * One-time backfill / reconcile. Copies every `.md` from `kbRoot` to
 * the equivalent path under `mirrorRoot`, creates parent dirs as it
 * goes, and prunes any mirrored `.md` whose source file is gone.
 *
 * Skip-unchanged avoids unnecessary copies: if the mirrored file is
 * byte-for-byte identical to the source (same size + same content), we
 * leave it alone. We deliberately do NOT key the skip on mtime — the
 * mirror's mtime is stamped from the source via `utimesSync` after each
 * copy, but that value round-trips through the host filesystem's
 * timestamp granularity. On some CI filesystems the stored mtime rounds
 * across a whole-second boundary, so a floor-to-seconds mtime compare
 * would spuriously see a "change" and re-copy an identical file. A
 * content compare is deterministic regardless of timestamp precision.
 *
 * Returns counts so the UI can show the user what happened.
 */
export function reconcileMirror(kbRoot: string, mirrorRootInput: string): BackfillResult {
  // Canonicalize at the boundary. The allowlist check operates on the
  // resolved absolute path so `~/Documents/../Library` is rejected,
  // and the subsequent fs calls all use the resolved path so a
  // user-stored `~/...` value doesn't end up creating a literal `~`
  // directory in the CWD.
  const mirrorRoot = normalizedMirrorPath(mirrorRootInput)
  if (!mirrorRoot) {
    throw new Error(
      `Spotlight mirror path must be a dedicated subdirectory under ~/Documents or ~/Desktop. Got: ${mirrorRootInput}`
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

      const srcStat = statSync(src)
      // Skip when the mirror already matches the source byte-for-byte.
      // Deterministic — unlike an mtime compare, which is at the mercy
      // of `utimesSync` round-tripping through the host filesystem's
      // timestamp granularity (see the function doc comment). An
      // unreadable/absent destination compares as "changed" so we fall
      // through and re-copy rather than erroring.
      if (mirrorMatchesSource(src, srcStat.size, dst)) {
        result.skipped++
        continue
      }
      copyFileSync(src, dst)
      // Stamp the destination with the source's mtime so the mirrored
      // file reflects when the note was actually last modified (nicer
      // for Spotlight / Finder). The skip check above is content-based,
      // so this is cosmetic — not load-bearing for correctness.
      try {
        utimesSync(dst, srcStat.atime, srcStat.mtime)
      } catch {
        /* best-effort */
      }
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
  kbRootInput: string,
  mirrorRootInput: string,
  sourceAbsPath: string
): { kind: 'copied' | 'removed' | 'noop'; target: string | null } {
  // Resolve both roots once. The mirror root is rejected unless it's a
  // dedicated subdirectory under ~/Documents or ~/Desktop; the kb root
  // is resolved so the containment check works even if the caller
  // passed `~/...` or an unnormalized path.
  const mirrorRoot = normalizedMirrorPath(mirrorRootInput)
  if (!mirrorRoot) {
    return { kind: 'noop', target: null }
  }
  if (!sourceAbsPath.endsWith('.md')) {
    return { kind: 'noop', target: null }
  }
  const kbRoot = pathResolve(kbRootInput)
  const src = pathResolve(sourceAbsPath)

  // Separator-boundary containment check. The previous
  // `startsWith(kbRoot)` would have admitted `${kbRoot}-evil/x.md`.
  // Computing `relative(kbRoot, src)` and rejecting any result that
  // starts with `..` or is absolute is the canonical form — it
  // tolerates trailing-separator differences AND blocks traversal.
  const rel = relative(kbRoot, src)
  if (
    rel === '' ||
    rel.startsWith('..') ||
    rel.includes(`${PATH_SEP}..${PATH_SEP}`) ||
    rel.startsWith('/')
  ) {
    return { kind: 'noop', target: null }
  }
  const dst = mirrorTargetFor(mirrorRoot, rel)

  if (event === 'unlink') {
    if (existsSync(dst)) {
      rmSync(dst, { force: true })
      return { kind: 'removed', target: dst }
    }
    return { kind: 'noop', target: dst }
  }

  if (!existsSync(src)) {
    return { kind: 'noop', target: dst }
  }
  const dstDir = dirname(dst)
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
  copyFileSync(src, dst)
  // Mirror the source mtime so the copy reflects the note's real
  // last-modified time in Spotlight / Finder. `reconcileMirror`'s
  // skip check is content-based, so this is cosmetic, not
  // load-bearing.
  try {
    const srcStat = statSync(src)
    utimesSync(dst, srcStat.atime, srcStat.mtime)
  } catch {
    /* best-effort */
  }
  return { kind: 'copied', target: dst }
}

// Exported for tests.
export const _internal = { walkMarkdown, README_BODY, README_FILENAME }
