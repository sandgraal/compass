/**
 * Documents full-text search — real in-memory SQLite with the same
 * `documents_fts` external-content FTS5 + triggers the app creates. Proves ⌘K
 * can find a document by a word that only appears inside the file.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchDocuments } from './documents-search'

let sqlite: Database.Database

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_name TEXT NOT NULL,
      sha256 TEXT NOT NULL, stored_path TEXT NOT NULL, extracted_text TEXT
    );
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      title, extracted_text,
      content='documents', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, extracted_text) VALUES (new.id, new.title, new.extracted_text);
    END;
  `)
})

afterEach(() => sqlite.close())

let seq = 0
function addDoc(title: string, text: string | null): void {
  seq++
  sqlite
    .prepare(
      'INSERT INTO documents (title, file_name, sha256, stored_path, extracted_text) VALUES (?,?,?,?,?)'
    )
    .run(title, `${title}.pdf`, `sha-${seq}`, `${seq}.pdf`, text)
}

describe('searchDocuments', () => {
  it('finds a document by a word that only appears in the extracted text', () => {
    addDoc('Statement 2026', 'Wells Fargo checking — direct deposit from Umbrella Corp')
    addDoc('Lease', 'landlord tenant rent due monthly')
    const hits = searchDocuments(sqlite, { q: 'umbrella' })
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Statement 2026')
  })

  it('finds a document by a title word', () => {
    addDoc('Passport scan', 'no body text worth mentioning')
    const hits = searchDocuments(sqlite, { q: 'passport' })
    expect(hits.map((h) => h.title)).toContain('Passport scan')
  })

  it('prefix-matches the last term', () => {
    addDoc('Insurance', 'comprehensive coverage policy declarations')
    expect(searchDocuments(sqlite, { q: 'compreh' })).toHaveLength(1)
  })

  it('returns nothing for an empty query', () => {
    addDoc('X', 'y')
    expect(searchDocuments(sqlite, { q: '   ' })).toEqual([])
  })

  it('does not throw when a document has no extracted text', () => {
    addDoc('Image only', null)
    expect(searchDocuments(sqlite, { q: 'image' }).map((h) => h.title)).toContain('Image only')
  })
})
