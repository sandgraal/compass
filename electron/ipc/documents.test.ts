/**
 * Documents store IPC — real in-memory SQLite + a real temp DOCUMENTS_DIR.
 * `insertRecords` (the spine projection) is mocked to a spy so this suite stays
 * focused on the documents domain without pulling in records.ts's dep tree.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({ getDb: () => drizzle(sqlite, { schema }) }))
vi.mock('../lib/pdf', () => ({
  extractPdfText: vi.fn(async () => ({ text: 'ACME invoice — total 4200 due March', pages: 3 }))
}))
vi.mock('./records', () => ({ insertRecords: vi.fn(() => ({ imported: 1 })) }))
vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(async () => '') }
}))
// A throwaway DOCUMENTS_DIR under the OS temp dir — never the real user store.
const { DOCS_DIR } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const fs = require('node:fs') as typeof import('node:fs')
  return { DOCS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'compass-docs-test-')) }
})
vi.mock('../paths', () => ({ DOCUMENTS_DIR: DOCS_DIR }))

const db = () => drizzle(sqlite, { schema })
let srcDir: string

async function setup(): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const { registerDocumentsHandlers } = await import('./documents')
  const h: Record<string, (...a: unknown[]) => unknown> = {}
  registerDocumentsHandlers({
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      h[ch] = fn
    }
  } as unknown as IpcMain)
  return h
}

/** Write a source file to import and return its path. */
function srcFile(name: string, content: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, content)
  return p
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
      mime_type TEXT, byte_size INTEGER, sha256 TEXT NOT NULL UNIQUE, stored_path TEXT NOT NULL,
      extracted_text TEXT, page_count INTEGER, doc_date TEXT, category TEXT, notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE document_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, created_at INTEGER
    );
    CREATE UNIQUE INDEX document_links_doc_target ON document_links (document_id, target_kind, target_id);
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
  `)
  srcDir = mkdtempSync(join(tmpdir(), 'compass-docsrc-'))
})

afterEach(() => {
  sqlite.close()
  vi.clearAllMocks()
})

describe('documents:import-paths', () => {
  it('imports a text file, storing its content for search + projecting a spine row', async () => {
    const h = await setup()
    const { insertRecords } = await import('./records')
    const p = srcFile('notes.txt', 'quarterly budget for the acme project')

    const res = (await h['documents:import-paths']({}, [p])) as { imported: number }
    expect(res.imported).toBe(1)

    const row = db().select().from(schema.documents).all()[0]
    expect(row.fileName).toBe('notes.txt')
    expect(row.mimeType).toBe('text/plain')
    expect(row.extractedText).toContain('acme project')
    expect(row.storedPath).toMatch(/^[a-f0-9]{64}\.txt$/) // content-hash name, never the source path

    // The lightweight document|file spine projection fired.
    expect(insertRecords).toHaveBeenCalledTimes(1)
    const [inputs] = (insertRecords as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [Array<{ source: string; type: string; naturalKey: string }>]
    expect(inputs[0].source).toBe('document')
    expect(inputs[0].type).toBe('file')
  })

  it('extracts PDF text via extractPdfText and records the page count', async () => {
    const h = await setup()
    const p = srcFile('invoice.pdf', '%PDF-1.4 binary-ish')
    await h['documents:import-paths']({}, [p])
    const row = db().select().from(schema.documents).all()[0]
    expect(row.extractedText).toContain('ACME invoice')
    expect(row.pageCount).toBe(3)
  })

  it('dedupes a re-import of identical content by sha256', async () => {
    const h = await setup()
    const p = srcFile('a.txt', 'same bytes')
    const p2 = srcFile('b.txt', 'same bytes') // different name, identical content
    await h['documents:import-paths']({}, [p])
    const res = (await h['documents:import-paths']({}, [p2])) as {
      imported: number
      duplicates: number
    }
    expect(res.imported).toBe(0)
    expect(res.duplicates).toBe(1)
    expect(db().select().from(schema.documents).all()).toHaveLength(1)
  })

  it('skips unsupported file types', async () => {
    const h = await setup()
    const p = srcFile('malware.exe', 'MZ')
    const res = (await h['documents:import-paths']({}, [p])) as {
      imported: number
      skipped: number
    }
    expect(res.imported).toBe(0)
    expect(res.skipped).toBe(1)
  })
})

describe('documents attach / detach', () => {
  it('attaches to a target then detaches', async () => {
    const h = await setup()
    await h['documents:import-paths']({}, [srcFile('x.txt', 'hi')])
    const id = db().select().from(schema.documents).all()[0].id

    const a = (await h['documents:attach'](
      {},
      {
        documentId: id,
        targetKind: 'record',
        targetId: '42'
      }
    )) as { success: boolean }
    expect(a.success).toBe(true)
    // Idempotent — the unique index means a repeat is a no-op, not a duplicate.
    await h['documents:attach']({}, { documentId: id, targetKind: 'record', targetId: '42' })
    let links = db().select().from(schema.documentLinks).all()
    expect(links).toHaveLength(1)

    await h['documents:detach']({}, links[0].id)
    links = db().select().from(schema.documentLinks).all()
    expect(links).toHaveLength(0)
  })

  it('rejects an attachment with an unknown target kind', async () => {
    const h = await setup()
    await h['documents:import-paths']({}, [srcFile('x.txt', 'hi')])
    const id = db().select().from(schema.documents).all()[0].id
    const r = (await h['documents:attach'](
      {},
      {
        documentId: id,
        targetKind: 'evil',
        targetId: '1'
      }
    )) as { success: boolean }
    expect(r.success).toBe(false)
    expect(db().select().from(schema.documentLinks).all()).toHaveLength(0)
  })
})

describe('documents:delete', () => {
  it('removes the stored file, the row, its links, and the spine projection', async () => {
    const h = await setup()
    await h['documents:import-paths']({}, [srcFile('bye.txt', 'delete me')])
    const doc = db().select().from(schema.documents).all()[0]
    await h['documents:attach']({}, { documentId: doc.id, targetKind: 'record', targetId: '7' })
    // Simulate the spine projection the mocked insertRecords didn't actually write.
    sqlite
      .prepare('INSERT INTO records (source, type, title, payload, dedup_hash) VALUES (?,?,?,?,?)')
      .run('document', 'file', 'bye', JSON.stringify({ sha256: doc.sha256 }), `doc-${doc.sha256}`)

    expect(readdirSync(DOCS_DIR)).toContain(doc.storedPath)

    const r = (await h['documents:delete']({}, doc.id)) as { success: boolean }
    expect(r.success).toBe(true)
    expect(db().select().from(schema.documents).all()).toHaveLength(0)
    expect(db().select().from(schema.documentLinks).all()).toHaveLength(0)
    expect(
      db()
        .select()
        .from(schema.records)
        .all()
        .filter((x) => x.source === 'document')
    ).toHaveLength(0)
    expect(readdirSync(DOCS_DIR)).not.toContain(doc.storedPath)
    // The stored file we wrote is gone.
    expect(() => readFileSync(join(DOCS_DIR, doc.storedPath))).toThrow()
  })
})

describe('path-traversal guard', () => {
  it('refuses a stored_path that escapes DOCUMENTS_DIR', async () => {
    const { __test } = await import('./documents')
    expect(() => __test.resolveStored('../../etc/passwd')).toThrow()
    expect(() => __test.resolveStored('deadbeef.pdf')).not.toThrow()
  })
})
