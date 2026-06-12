/**
 * Obsidian vault bridge — Phase 7 Track B.
 *
 * Two-way markdown bridge between a user-chosen Obsidian vault (any local
 * folder of `.md` files) and the Compass knowledge base. No cloud, no OAuth —
 * pure local file mirroring, same trust posture as Apple Calendar (5.7) and
 * the Spotlight mirror (5.14).
 *
 * Conflict-free by construction: two ONE-WAY mirrors with disjoint
 * namespaces, so the same file is never written from both sides.
 *
 *   import:  <vault>/**           →  knowledge-base/obsidian/**
 *   export:  knowledge-base/**    →  <vault>/Compass/**
 *            (minus obsidian/)
 *
 * The import excludes the vault's `Compass/` export target (and `.obsidian`,
 * `.trash`, dotdirs); the export excludes `knowledge-base/obsidian/` — so a
 * note never round-trips back to where it came from. Each side mirrors the
 * Spotlight-mirror semantics: mtime-skip copy, source-mtime stamping, and a
 * prune pass scoped strictly to the dedicated destination namespace.
 *
 * Safety rails:
 *   - vault path must be an existing directory, not inside the Compass app
 *     data dir, and not an ancestor of it (either nesting would self-mirror)
 *   - `<vault>/Compass` is only adopted as the export target if WE created
 *     it (marker file). A pre-existing user folder named `Compass` aborts
 *     the export with a clear error instead of pruning the user's notes.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as pathResolve, relative } from 'node:path'
import { eq } from 'drizzle-orm'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/client'
import { appSettings, integrations, syncEvents } from '../db/schema'
import { APP_DATA_DIR, KNOWLEDGE_DIR } from '../paths'

/** Knowledge-base subdirectory that receives the vault import. */
export const OBSIDIAN_IMPORT_SUBDIR = 'obsidian'
/** Vault subdirectory that receives the Compass export. */
export const VAULT_EXPORT_SUBDIR = 'Compass'
/** Marker proving `<vault>/Compass` is ours to manage (and prune). */
export const EXPORT_MARKER = '.compass-mirror'
/** app_settings key holding the configured vault path. */
export const VAULT_PATH_SETTING = 'obsidianVaultPath'

export interface MirrorResult {
  copied: number
  skipped: number
  removed: number
  errors: Array<{ path: string; message: string }>
}

export type VaultValidation =
  | { ok: true; path: string; looksLikeVault: boolean }
  | { ok: false; error: string }

/** `~` expansion + `..` collapse, no filesystem access. Relative input → null. */
export function resolveVaultPath(input: string): string | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null
  const trimmed = input.trim()
  const expanded = trimmed.startsWith('~') ? join(homedir(), trimmed.slice(1)) : trimmed
  // Absoluteness must be checked BEFORE pathResolve — resolve() would turn a
  // relative input into a cwd-anchored absolute path and defeat the check.
  // isAbsolute (not startsWith('/')) so Windows drive-letter paths pass.
  if (!isAbsolute(expanded)) return null
  return pathResolve(expanded)
}

/** Separator-boundary "a contains b (or equals)" check on resolved paths. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  // An absolute rel means different roots (e.g. different Windows drives)
  // — definitely not contained. startsWith('/') alone would miss `D:\...`.
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function validateVaultPath(
  input: string,
  opts: { appDataDir?: string } = {}
): VaultValidation {
  const appDataDir = pathResolve(opts.appDataDir ?? APP_DATA_DIR)
  const abs = resolveVaultPath(input)
  if (!abs) return { ok: false, error: 'Vault path must be an absolute path (or start with ~).' }
  if (!existsSync(abs)) return { ok: false, error: `Folder does not exist: ${abs}` }
  if (!statSync(abs).isDirectory()) return { ok: false, error: `Not a folder: ${abs}` }
  // Either nesting direction would make the bridge mirror into itself
  // (the knowledge base lives inside the app data dir).
  if (contains(appDataDir, abs)) {
    return { ok: false, error: 'Vault cannot live inside the Compass data directory.' }
  }
  if (contains(abs, appDataDir)) {
    return { ok: false, error: 'Vault cannot contain the Compass data directory.' }
  }
  return { ok: true, path: abs, looksLikeVault: existsSync(join(abs, '.obsidian')) }
}

/** Recursively collect `.md` paths (relative to `base`), skipping dot-dirs + named dirs. */
function walkMarkdown(dir: string, base: string, skipDirs: ReadonlySet<string>): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue
      out.push(...walkMarkdown(full, base, skipDirs))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(relative(base, full))
    }
  }
  return out
}

/**
 * One-way mirror of the `.md` tree under `srcRoot` into `dstRoot` —
 * mtime-skip copy + source-mtime stamp + prune of dst files whose source is
 * gone (the prune is what makes the dedicated-namespace rule load-bearing:
 * everything under `dstRoot` is assumed to be ours). Mirrors the semantics
 * of `spotlight-mirror.ts#reconcileMirror`.
 */
export function mirrorMarkdownTree(
  srcRoot: string,
  dstRoot: string,
  skipDirs: ReadonlySet<string> = new Set(),
  /** Absolute dst paths exempt from the prune pass (e.g. our README). */
  keep: ReadonlySet<string> = new Set()
): MirrorResult {
  const result: MirrorResult = { copied: 0, skipped: 0, removed: 0, errors: [] }
  if (!existsSync(dstRoot)) mkdirSync(dstRoot, { recursive: true })

  const sourceFiles = walkMarkdown(srcRoot, srcRoot, skipDirs)
  const expected = new Set<string>(keep)

  for (const rel of sourceFiles) {
    const src = join(srcRoot, rel)
    const dst = join(dstRoot, rel)
    expected.add(dst)
    try {
      const dstDir = dirname(dst)
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
      const srcStat = statSync(src)
      if (existsSync(dst)) {
        const dstStat = statSync(dst)
        // Whole-second compare — see spotlight-mirror for the rationale.
        if (Math.floor(srcStat.mtimeMs / 1000) === Math.floor(dstStat.mtimeMs / 1000)) {
          result.skipped++
          continue
        }
      }
      copyFileSync(src, dst)
      try {
        utimesSync(dst, srcStat.atime, srcStat.mtime)
      } catch {
        /* best-effort; next reconcile recopies */
      }
      result.copied++
    } catch (err) {
      result.errors.push({ path: rel, message: (err as Error).message })
    }
  }

  // Prune dst .md files whose source vanished + best-effort empty-dir cleanup.
  function prune(dir: string): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        prune(full)
        try {
          // recursive:true is required for directories even when empty.
          if (full !== dstRoot && readdirSync(full).length === 0) {
            rmSync(full, { recursive: true, force: true })
          }
        } catch {
          /* ignore */
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && !expected.has(full)) {
        try {
          rmSync(full, { force: true })
          result.removed++
        } catch (err) {
          // Relative path: consistent with the copy-phase entries, and keeps
          // absolute local paths out of sync_events.errors.
          result.errors.push({ path: relative(dstRoot, full), message: (err as Error).message })
        }
      }
    }
  }
  prune(dstRoot)
  return result
}

const EXPORT_README = `# Compass notes (read-only mirror)

This folder is a one-way copy of your Compass knowledge base, refreshed on
every Obsidian sync. Edits made HERE are not synced back to Compass and will
be overwritten — edit the originals in the Compass app instead.

Notes you write elsewhere in this vault are imported into Compass under
\`obsidian/\` (also one-way: the vault stays their source of truth).
`

export interface BridgeResult {
  imported: MirrorResult
  exported: MirrorResult
}

/**
 * Run both one-way mirrors. Throws (rather than returning per-file errors)
 * only for the structural failure: a pre-existing `<vault>/Compass` folder
 * we didn't create, which we must not prune.
 */
export function syncObsidianBridge(vaultPath: string, knowledgeDir = KNOWLEDGE_DIR): BridgeResult {
  const importDst = join(knowledgeDir, OBSIDIAN_IMPORT_SUBDIR)
  const exportDst = join(vaultPath, VAULT_EXPORT_SUBDIR)

  // Adopt-or-abort the export namespace BEFORE any writes.
  if (existsSync(exportDst)) {
    if (!existsSync(join(exportDst, EXPORT_MARKER))) {
      throw new Error(
        `The vault already has a "${VAULT_EXPORT_SUBDIR}" folder that Compass didn't create. Rename or remove it (Compass prunes that folder on every sync).`
      )
    }
  } else {
    mkdirSync(exportDst, { recursive: true })
  }
  writeFileSync(join(exportDst, EXPORT_MARKER), 'managed by Compass — do not remove\n', 'utf8')
  try {
    writeFileSync(join(exportDst, 'README.md'), EXPORT_README, 'utf8')
  } catch {
    /* best-effort */
  }

  // Import: vault → knowledge-base/obsidian, excluding our own export target.
  const imported = mirrorMarkdownTree(vaultPath, importDst, new Set([VAULT_EXPORT_SUBDIR]))
  // Export: knowledge-base (minus the import namespace) → vault/Compass.
  // Our README.md lives only on the dst side — exempt it from the prune.
  const exported = mirrorMarkdownTree(
    knowledgeDir,
    exportDst,
    new Set([OBSIDIAN_IMPORT_SUBDIR]),
    new Set([join(exportDst, 'README.md')])
  )
  return { imported, exported }
}

export function readVaultPathSetting(): string | null {
  try {
    const db = getDb()
    const row = db.select().from(appSettings).where(eq(appSettings.key, VAULT_PATH_SETTING)).get()
    const value = row?.value?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

type SyncResult = { service: string; success: boolean; recordsUpdated?: number; error?: string }

/**
 * Full sync entry point, dispatched from `sync:trigger` / cron — same
 * integration-row + sync_events bookkeeping as `syncAppleCalendar`
 * (insert-on-conflict on BOTH paths so a first-ever failure still surfaces).
 */
export async function syncObsidian(mainWindow?: BrowserWindow | null): Promise<SyncResult> {
  const configured = readVaultPathSetting()
  if (!configured) {
    // Not configured is a state, not an error — don't flip integration rows.
    return { service: 'obsidian', success: false, error: 'Not connected' }
  }

  const db = getDb()
  try {
    const validation = validateVaultPath(configured)
    if (!validation.ok) throw new Error(validation.error)

    const { imported, exported } = syncObsidianBridge(validation.path)
    const recordsUpdated = imported.copied + imported.removed + exported.copied + exported.removed
    const fileErrors = [...imported.errors, ...exported.errors]

    db.insert(integrations)
      .values({
        service: 'obsidian',
        status: 'connected',
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        errorMessage: null
      })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'connected', lastSyncedAt: new Date(), errorMessage: null }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'obsidian'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({
          integrationId,
          syncedAt: new Date(),
          recordsUpdated,
          errors: fileErrors.length
            ? fileErrors
                .slice(0, 5)
                .map((e) => `${e.path}: ${e.message}`)
                .join('; ')
            : null
        })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'obsidian',
      status: 'done',
      recordsUpdated
    })
    return { service: 'obsidian', success: true, recordsUpdated }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.insert(integrations)
      .values({ service: 'obsidian', status: 'error', errorMessage: message })
      .onConflictDoUpdate({
        target: integrations.service,
        set: { status: 'error', errorMessage: message }
      })
      .run()
    const integrationId = db
      .select({ id: integrations.id })
      .from(integrations)
      .where(eq(integrations.service, 'obsidian'))
      .get()?.id
    if (integrationId != null) {
      db.insert(syncEvents)
        .values({ integrationId, syncedAt: new Date(), recordsUpdated: 0, errors: message })
        .run()
    }
    mainWindow?.webContents.send('sync:update', {
      service: 'obsidian',
      status: 'error',
      error: message
    })
    return { service: 'obsidian', success: false, error: message }
  }
}
