/**
 * Tests for the Obsidian vault bridge (Phase 7 Track B): path validation,
 * the one-way markdown mirror (copy / mtime-skip / prune / keep), the
 * two-mirror bridge with its disjoint-namespace + marker-adoption rules,
 * and the syncObsidian integration-row bookkeeping (real in-memory SQLite).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let root: string
let vault: string
let knowledge: string
let appData: string
let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

vi.mock('../paths', () => ({
  get APP_DATA_DIR() {
    return appData
  },
  get KNOWLEDGE_DIR() {
    return knowledge
  }
}))

function write(base: string, rel: string, content: string, mtime?: Date): void {
  const full = join(base, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
  if (mtime) utimesSync(full, mtime, mtime)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'compass-obsidian-test-'))
  vault = join(root, 'vault')
  appData = join(root, 'appdata')
  knowledge = join(appData, 'knowledge-base')
  mkdirSync(vault, { recursive: true })
  mkdirSync(knowledge, { recursive: true })

  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );
    CREATE TABLE sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER NOT NULL,
      synced_at INTEGER,
      records_updated INTEGER DEFAULT 0,
      errors TEXT
    );
  `)
})

afterEach(() => {
  sqlite.close()
  rmSync(root, { recursive: true, force: true })
})

// ── validateVaultPath ────────────────────────────────────────────────────────

describe('validateVaultPath', () => {
  it('accepts an existing directory and detects .obsidian', async () => {
    const { validateVaultPath } = await import('./obsidian')
    expect(validateVaultPath(vault, { appDataDir: appData })).toEqual({
      ok: true,
      path: vault,
      looksLikeVault: false
    })
    mkdirSync(join(vault, '.obsidian'))
    expect(validateVaultPath(vault, { appDataDir: appData })).toMatchObject({
      ok: true,
      looksLikeVault: true
    })
  })

  it('rejects missing paths, files, and relative input', async () => {
    const { validateVaultPath } = await import('./obsidian')
    expect(validateVaultPath(join(root, 'nope'), { appDataDir: appData }).ok).toBe(false)
    write(root, 'file.md', 'x')
    expect(validateVaultPath(join(root, 'file.md'), { appDataDir: appData }).ok).toBe(false)
    expect(validateVaultPath('relative/path', { appDataDir: appData }).ok).toBe(false)
    expect(validateVaultPath('', { appDataDir: appData }).ok).toBe(false)
    // Relative input must be rejected even when it RESOLVES to an existing
    // dir — pathResolve would silently anchor it to cwd otherwise.
    expect(validateVaultPath('.', { appDataDir: appData }).ok).toBe(false)
  })

  it('rejects either nesting with the app data dir', async () => {
    const { validateVaultPath } = await import('./obsidian')
    const inside = join(appData, 'inner-vault')
    mkdirSync(inside, { recursive: true })
    expect(validateVaultPath(inside, { appDataDir: appData }).ok).toBe(false)
    // root contains appData → also rejected
    expect(validateVaultPath(root, { appDataDir: appData }).ok).toBe(false)
  })
})

// ── mirrorMarkdownTree ───────────────────────────────────────────────────────

describe('mirrorMarkdownTree', () => {
  it('copies .md files (with subdirs), skips dot-dirs and named dirs, ignores non-md', async () => {
    const { mirrorMarkdownTree } = await import('./obsidian')
    write(vault, 'a.md', 'A')
    write(vault, 'sub/b.md', 'B')
    write(vault, '.obsidian/config.md', 'hidden')
    write(vault, 'Skipme/c.md', 'C')
    write(vault, 'image.png', 'binary')

    const dst = join(root, 'dst')
    const r = mirrorMarkdownTree(vault, dst, new Set(['Skipme']))
    expect(r).toMatchObject({ copied: 2, skipped: 0, removed: 0 })
    expect(readFileSync(join(dst, 'a.md'), 'utf8')).toBe('A')
    expect(readFileSync(join(dst, 'sub/b.md'), 'utf8')).toBe('B')
    expect(existsSync(join(dst, '.obsidian'))).toBe(false)
    expect(existsSync(join(dst, 'Skipme'))).toBe(false)
    expect(existsSync(join(dst, 'image.png'))).toBe(false)
  })

  it('is idempotent via mtime-skip, recopies on change', async () => {
    const { mirrorMarkdownTree } = await import('./obsidian')
    write(vault, 'a.md', 'v1', new Date('2026-01-01T00:00:00Z'))
    const dst = join(root, 'dst')

    expect(mirrorMarkdownTree(vault, dst).copied).toBe(1)
    expect(mirrorMarkdownTree(vault, dst)).toMatchObject({ copied: 0, skipped: 1 })

    write(vault, 'a.md', 'v2', new Date('2026-02-01T00:00:00Z'))
    expect(mirrorMarkdownTree(vault, dst).copied).toBe(1)
    expect(readFileSync(join(dst, 'a.md'), 'utf8')).toBe('v2')
  })

  it('prunes dst files whose source is gone (plus empty dirs), honoring keep', async () => {
    const { mirrorMarkdownTree } = await import('./obsidian')
    write(vault, 'sub/b.md', 'B')
    const dst = join(root, 'dst')
    mirrorMarkdownTree(vault, dst)
    write(dst, 'stale/old.md', 'old')
    write(dst, 'KEEP.md', 'mine')

    const r = mirrorMarkdownTree(vault, dst, new Set(), new Set([join(dst, 'KEEP.md')]))
    expect(r.removed).toBe(1)
    expect(existsSync(join(dst, 'stale'))).toBe(false)
    expect(existsSync(join(dst, 'KEEP.md'))).toBe(true)
    expect(existsSync(join(dst, 'sub/b.md'))).toBe(true)
  })
})

// ── syncObsidianBridge ───────────────────────────────────────────────────────

describe('syncObsidianBridge', () => {
  it('imports vault → knowledge/obsidian and exports knowledge → vault/Compass with disjoint namespaces', async () => {
    const { syncObsidianBridge } = await import('./obsidian')
    write(vault, 'idea.md', 'vault idea')
    write(vault, '.obsidian/workspace.md', 'settings')
    write(knowledge, 'profile/me.md', 'compass note')

    const r = syncObsidianBridge(vault, knowledge)
    expect(r.imported.copied).toBe(1)
    expect(r.exported.copied).toBe(1)
    expect(readFileSync(join(knowledge, 'obsidian/idea.md'), 'utf8')).toBe('vault idea')
    expect(readFileSync(join(vault, 'Compass/profile/me.md'), 'utf8')).toBe('compass note')
    expect(existsSync(join(vault, 'Compass/README.md'))).toBe(true)
    expect(existsSync(join(vault, 'Compass/.compass-mirror'))).toBe(true)

    // Second run: nothing round-trips, README survives the prune.
    const r2 = syncObsidianBridge(vault, knowledge)
    expect(r2.imported.copied).toBe(0)
    expect(r2.exported.copied).toBe(0)
    expect(r2.imported.removed).toBe(0)
    expect(r2.exported.removed).toBe(0)
    expect(existsSync(join(vault, 'Compass/README.md'))).toBe(true)
    // The export target never re-imports; the import namespace never re-exports.
    expect(existsSync(join(knowledge, 'obsidian/Compass'))).toBe(false)
    expect(existsSync(join(vault, 'Compass/obsidian'))).toBe(false)
  })

  it('refuses to adopt a pre-existing Compass folder it did not create', async () => {
    const { syncObsidianBridge } = await import('./obsidian')
    write(vault, 'Compass/users-own-note.md', 'precious')
    expect(() => syncObsidianBridge(vault, knowledge)).toThrow(/didn't create/)
    // Nothing was pruned or written.
    expect(readFileSync(join(vault, 'Compass/users-own-note.md'), 'utf8')).toBe('precious')
  })
})

// ── syncObsidian (integration-row bookkeeping) ───────────────────────────────

function setVaultSetting(path: string): void {
  sqlite
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
    .run('obsidianVaultPath', path)
}

describe('syncObsidian', () => {
  it('returns Not connected without touching rows when unconfigured', async () => {
    const { syncObsidian } = await import('./obsidian')
    const r = await syncObsidian(null)
    expect(r).toEqual({ service: 'obsidian', success: false, error: 'Not connected' })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM integrations').get()).toMatchObject({ c: 0 })
  })

  it('syncs, upserts the integration row, and logs a sync event', async () => {
    const { syncObsidian } = await import('./obsidian')
    setVaultSetting(vault)
    write(vault, 'note.md', 'hello')

    const r = await syncObsidian(null)
    expect(r.success).toBe(true)
    expect(r.recordsUpdated).toBe(1)
    const row = sqlite
      .prepare("SELECT * FROM integrations WHERE service = 'obsidian'")
      .get() as Record<string, unknown>
    expect(row.status).toBe('connected')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM sync_events').get()).toMatchObject({ c: 1 })
  })

  it('surfaces a first-ever failure via row upsert (vault vanished)', async () => {
    const { syncObsidian } = await import('./obsidian')
    setVaultSetting(join(root, 'gone'))

    const r = await syncObsidian(null)
    expect(r.success).toBe(false)
    const row = sqlite
      .prepare("SELECT * FROM integrations WHERE service = 'obsidian'")
      .get() as Record<string, unknown>
    expect(row.status).toBe('error')
    expect(String(row.error_message)).toContain('does not exist')
    expect(sqlite.prepare('SELECT COUNT(*) c FROM sync_events').get()).toMatchObject({ c: 1 })
  })
})
