/**
 * Tests for the `obsidian:*` IPC handlers (Phase 7 Track B): status
 * round-trip with live re-validation, vault-path persistence + integration
 * row upsert, and clear. Real in-memory SQLite; real temp dirs standing in
 * for the vault + app data dir (the paths module is mocked).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let root: string
let vault: string
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
    return join(appData, 'knowledge-base')
  }
}))

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle']
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const mod = await import('./obsidian')
  mod.registerObsidianHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h({}, ...args)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'compass-obsidian-ipc-'))
  vault = join(root, 'vault')
  appData = join(root, 'appdata')
  mkdirSync(vault, { recursive: true })
  mkdirSync(appData, { recursive: true })

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
  `)
})

afterEach(() => {
  sqlite.close()
  rmSync(root, { recursive: true, force: true })
})

describe('obsidian:get-status', () => {
  it('reports unconfigured when no path is stored', async () => {
    expect(await invoke('obsidian:get-status')).toEqual({
      configured: false,
      vaultPath: null,
      looksLikeVault: false,
      error: null
    })
  })

  it('re-validates the stored path so a moved vault surfaces as an error', async () => {
    await invoke('obsidian:set-vault-path', vault)
    expect(await invoke('obsidian:get-status')).toMatchObject({
      configured: true,
      vaultPath: vault,
      error: null
    })

    rmSync(vault, { recursive: true, force: true })
    const status = (await invoke('obsidian:get-status')) as { error: string | null }
    expect(status.error).toContain('does not exist')
  })
})

describe('obsidian:set-vault-path', () => {
  it('rejects non-strings and invalid folders without persisting', async () => {
    expect(await invoke('obsidian:set-vault-path', 42)).toMatchObject({ success: false })
    expect(await invoke('obsidian:set-vault-path', join(root, 'missing'))).toMatchObject({
      success: false
    })
    expect(sqlite.prepare('SELECT COUNT(*) c FROM app_settings').get()).toMatchObject({ c: 0 })
  })

  it('persists the resolved path and upserts the integration row as connected', async () => {
    mkdirSync(join(vault, '.obsidian'))
    const r = await invoke('obsidian:set-vault-path', vault)
    expect(r).toEqual({ success: true, looksLikeVault: true })

    const setting = sqlite
      .prepare("SELECT value FROM app_settings WHERE key = 'obsidianVaultPath'")
      .get() as { value: string }
    expect(setting.value).toBe(vault)
    const row = sqlite
      .prepare("SELECT status FROM integrations WHERE service = 'obsidian'")
      .get() as { status: string }
    expect(row.status).toBe('connected')

    // Re-set (e.g. Change vault) updates in place — still a single row.
    await invoke('obsidian:set-vault-path', vault)
    expect(sqlite.prepare('SELECT COUNT(*) c FROM integrations').get()).toMatchObject({ c: 1 })
  })
})

describe('obsidian:clear', () => {
  it('forgets the path and flips the row to disconnected', async () => {
    await invoke('obsidian:set-vault-path', vault)
    expect(await invoke('obsidian:clear')).toEqual({ success: true })

    expect(sqlite.prepare('SELECT COUNT(*) c FROM app_settings').get()).toMatchObject({ c: 0 })
    const row = sqlite
      .prepare("SELECT status FROM integrations WHERE service = 'obsidian'")
      .get() as { status: string }
    expect(row.status).toBe('disconnected')
  })
})
