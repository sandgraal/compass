/**
 * Documents & files store (Phase 9.2 "Storehouse").
 *
 * Import a file → copy the original under DOCUMENTS_DIR (named by content hash),
 * extract PDF / plain-text into `documents.extracted_text` (indexed by
 * `documents_fts` so ⌘K finds a word from inside the file), and project a
 * lightweight `document|file` row onto the records spine so it shows on the
 * Timeline. A document can attach to any record or derived entity via
 * `document_links`.
 *
 * SECURITY: stored files are always named `${sha256}${ext}` (never a user path
 * segment), and every path that comes back out of the DB is resolved against
 * DOCUMENTS_DIR and asserted to stay inside it before any fs/shell touch — so a
 * tampered `stored_path` can't escape the store. Imports are extension/MIME
 * allowlisted and size-capped. Content is on-device plaintext (matches how
 * imported records store content); the vault stays the home for encrypted data.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { type IpcMain, dialog, shell } from 'electron'
import { getDb } from '../db/client'
import { documentLinks, documents, records } from '../db/schema'
import { extractPdfText } from '../lib/pdf'
import type { RecordInput } from '../lib/recognizers'
import { DOCUMENTS_DIR } from '../paths'
import { insertRecords } from './records'

/** 50 MB — matches the records/contacts/finance import guard. */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024

/** Extension → MIME allowlist. An unknown extension is rejected at import. */
const ALLOWED_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.rtf': 'application/rtf',
  '.json': 'application/json',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
const ALLOWED_EXTS = Object.keys(ALLOWED_TYPES).map((e) => e.slice(1))

/** Plain-text extensions we can index directly (PDFs go through pdf-parse). */
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json'])

/** Targets a document may attach to (a records-spine row or a derived entity). */
const TARGET_KINDS = new Set(['record', 'contact', 'merchant', 'place', 'asset', 'subscription'])

type PerFile = {
  fileName: string
  status: 'imported' | 'duplicate' | 'skipped'
  reason?: string
  id?: number
}
export type DocumentsImportResult = {
  imported: number
  duplicates: number
  skipped: number
  perFile: PerFile[]
}

/** Resolve a DB `stored_path` to an absolute path, refusing anything that
 *  escapes DOCUMENTS_DIR (defense-in-depth against a tampered row). */
function resolveStored(storedPath: string): string {
  const abs = resolve(DOCUMENTS_DIR, storedPath)
  if (abs !== DOCUMENTS_DIR && !abs.startsWith(DOCUMENTS_DIR + sep)) {
    throw new Error('stored path escapes the documents directory')
  }
  return abs
}

/** Pull searchable text out of a freshly-stored file (PDF or plain text). */
async function extractText(
  abs: string,
  ext: string,
  mime: string
): Promise<{ text: string | null; pages: number | null }> {
  try {
    if (mime === 'application/pdf') {
      const r = await extractPdfText(abs)
      return { text: r.text || null, pages: r.pages || null }
    }
    if (TEXT_EXTS.has(ext)) {
      const t = readFileSync(abs, 'utf-8').slice(0, 500_000).trim()
      return { text: t || null, pages: null }
    }
  } catch {
    /* extraction is best-effort — a document still imports without its text */
  }
  return { text: null, pages: null }
}

/** Import one file into the store (copy + hash + extract + insert + project). */
async function importOne(srcPath: string): Promise<PerFile> {
  const fileName = basename(srcPath)
  const ext = extname(fileName).toLowerCase()
  const mime = ALLOWED_TYPES[ext]
  if (!mime) return { fileName, status: 'skipped', reason: 'unsupported file type' }

  let size: number
  try {
    size = statSync(srcPath).size
  } catch {
    return { fileName, status: 'skipped', reason: 'unreadable file' }
  }
  if (size > MAX_IMPORT_BYTES) return { fileName, status: 'skipped', reason: 'over 50 MB' }

  const buf = readFileSync(srcPath)
  const sha256 = createHash('sha256').update(buf).digest('hex')

  const db = getDb()
  const existing = db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.sha256, sha256))
    .get()
  if (existing) return { fileName, status: 'duplicate', id: existing.id }

  // Store under a content-hash name — never a user path segment.
  mkdirSync(DOCUMENTS_DIR, { recursive: true })
  const storedPath = `${sha256}${ext}`
  writeFileSync(resolveStored(storedPath), buf)

  const { text, pages } = await extractText(resolveStored(storedPath), ext, mime)
  const title =
    fileName.replace(new RegExp(`${ext.replace('.', '\\.')}$`, 'i'), '').trim() || fileName

  const res = db
    .insert(documents)
    .values({
      title,
      fileName,
      mimeType: mime,
      byteSize: size,
      sha256,
      storedPath,
      extractedText: text,
      pageCount: pages,
      source: 'manual'
    })
    .run()
  const id = Number(res.lastInsertRowid)

  // Project a lightweight timeline row (title + optional date, NO body text) so
  // the document shows on the Timeline; naturalKey = sha256 dedupes re-imports.
  const spine: RecordInput = {
    source: 'document',
    type: 'file',
    occurredAt: null,
    title,
    payload: { file: fileName, sha256 },
    naturalKey: sha256
  }
  insertRecords([spine], 'documents')

  return { fileName, status: 'imported', id }
}

async function importPaths(paths: string[]): Promise<DocumentsImportResult> {
  const perFile: PerFile[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    try {
      perFile.push(await importOne(p))
    } catch {
      perFile.push({ fileName: basename(p), status: 'skipped', reason: 'import failed' })
    }
  }
  return {
    imported: perFile.filter((f) => f.status === 'imported').length,
    duplicates: perFile.filter((f) => f.status === 'duplicate').length,
    skipped: perFile.filter((f) => f.status === 'skipped').length,
    perFile
  }
}

/** Delete the projected `document|file` spine rows for a given content hash. */
function deleteSpineFor(sha256: string): void {
  const db = getDb()
  const rows = db
    .select({ id: records.id, payload: records.payload })
    .from(records)
    .where(and(eq(records.source, 'document'), eq(records.type, 'file')))
    .all()
  const ids = rows
    .filter((r) => {
      try {
        return (JSON.parse(r.payload ?? '{}') as { sha256?: string }).sha256 === sha256
      } catch {
        return false
      }
    })
    .map((r) => r.id)
  if (ids.length > 0) db.delete(records).where(inArray(records.id, ids)).run()
}

const intId = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function registerDocumentsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('documents:import', async (): Promise<DocumentsImportResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import documents',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ALLOWED_EXTS }]
    })
    if (canceled || filePaths.length === 0) {
      return { imported: 0, duplicates: 0, skipped: 0, perFile: [] }
    }
    return importPaths(filePaths)
  })

  ipcMain.handle('documents:import-paths', (_e, paths: unknown): Promise<DocumentsImportResult> => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    return importPaths(list)
  })

  ipcMain.handle('documents:list', (_e, opts?: { category?: string }) => {
    const db = getDb()
    const conds = nonEmpty(opts?.category) ? [eq(documents.category, opts.category)] : []
    return db
      .select({
        id: documents.id,
        title: documents.title,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        byteSize: documents.byteSize,
        pageCount: documents.pageCount,
        docDate: documents.docDate,
        category: documents.category,
        // 0/1 — never loads the (potentially large) extracted text into the list.
        hasText: sql<number>`(${documents.extractedText} IS NOT NULL)`,
        createdAt: documents.createdAt
      })
      .from(documents)
      .where(and(...conds))
      .orderBy(desc(documents.createdAt))
      .all()
      .map((d) => ({
        ...d,
        hasText: d.hasText === 1,
        byteSize: d.byteSize ?? 0,
        createdAt: d.createdAt ? d.createdAt.getTime() : null
      }))
  })

  ipcMain.handle('documents:get', (_e, id: unknown) => {
    const docId = intId(id)
    if (docId == null) return null
    const db = getDb()
    const doc = db.select().from(documents).where(eq(documents.id, docId)).get()
    if (!doc) return null
    const links = db
      .select({
        id: documentLinks.id,
        targetKind: documentLinks.targetKind,
        targetId: documentLinks.targetId
      })
      .from(documentLinks)
      .where(eq(documentLinks.documentId, docId))
      .all()
    return {
      id: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      byteSize: doc.byteSize ?? 0,
      pageCount: doc.pageCount,
      docDate: doc.docDate,
      category: doc.category,
      notes: doc.notes,
      extractedText: doc.extractedText,
      createdAt: doc.createdAt ? doc.createdAt.getTime() : null,
      links
    }
  })

  ipcMain.handle(
    'documents:attach',
    (_e, args: { documentId?: unknown; targetKind?: unknown; targetId?: unknown }) => {
      const docId = intId(args?.documentId)
      const kind = args?.targetKind
      const targetId = args?.targetId
      if (
        docId == null ||
        typeof kind !== 'string' ||
        !TARGET_KINDS.has(kind) ||
        !nonEmpty(targetId)
      ) {
        return { success: false as const, error: 'invalid attachment' }
      }
      const db = getDb()
      db.insert(documentLinks)
        .values({ documentId: docId, targetKind: kind, targetId: targetId.trim() })
        .onConflictDoNothing()
        .run()
      return { success: true as const }
    }
  )

  ipcMain.handle('documents:detach', (_e, linkId: unknown) => {
    const id = intId(linkId)
    if (id == null) return { success: false as const, error: 'invalid link' }
    getDb().delete(documentLinks).where(eq(documentLinks.id, id)).run()
    return { success: true as const }
  })

  ipcMain.handle('documents:open', async (_e, id: unknown) => {
    const docId = intId(id)
    if (docId == null) return { success: false as const, error: 'invalid id' }
    const doc = getDb()
      .select({ storedPath: documents.storedPath })
      .from(documents)
      .where(eq(documents.id, docId))
      .get()
    if (!doc) return { success: false as const, error: 'not found' }
    try {
      const abs = resolveStored(doc.storedPath)
      if (!existsSync(abs)) return { success: false as const, error: 'file missing' }
      const err = await shell.openPath(abs)
      return err ? { success: false as const, error: err } : { success: true as const }
    } catch {
      return { success: false as const, error: 'could not open' }
    }
  })

  ipcMain.handle('documents:delete', (_e, id: unknown) => {
    const docId = intId(id)
    if (docId == null) return { success: false as const, error: 'invalid id' }
    const db = getDb()
    const doc = db
      .select({ storedPath: documents.storedPath, sha256: documents.sha256 })
      .from(documents)
      .where(eq(documents.id, docId))
      .get()
    if (!doc) return { success: false as const, error: 'not found' }
    // Remove the stored file (path-guarded), then the links, row, and spine record.
    try {
      const abs = resolveStored(doc.storedPath)
      if (existsSync(abs)) rmSync(abs, { force: true })
    } catch {
      /* leaving an orphan file is preferable to failing the delete */
    }
    db.delete(documentLinks).where(eq(documentLinks.documentId, docId)).run()
    db.delete(documents).where(eq(documents.id, docId)).run()
    deleteSpineFor(doc.sha256)
    return { success: true as const }
  })
}

// Exposed for tests (import/dedup/extraction logic without the IPC layer).
export const __test = { importPaths, importOne, deleteSpineFor, resolveStored, ALLOWED_TYPES }
