/**
 * Records / Timeline IPC (Phase 10.1 — "The Acquisition Engine").
 *
 * The Drop Zone: the user hands Compass any data-export file (drag-drop or file
 * picker); a recognizer normalizes it into the append-only `records` timeline.
 * Re-importing the same export is idempotent (UNIQUE `dedup_hash` +
 * `onConflictDoNothing`), exactly like the finance ledger.
 *
 * Local-only: reads files the user explicitly chose, writes a summary to the
 * knowledge base. No network, no vault, no CSP widening. Raw rows are NOT exposed
 * to the MCP/assistant in 10.1 (a unified timeline is sensitive) — summaries only.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { type SQL, and, desc, eq } from 'drizzle-orm'
import { type IpcMain, dialog } from 'electron'
import { getDb } from '../db/client'
import { records } from '../db/schema'
import { updateRecordsKnowledge } from '../knowledge/records-extractor'
import { serializeCsv } from '../lib/csv'
import { type RecordInput, hashRecord, recognize } from '../lib/recognizers'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024 // 50 MB — matches the contacts/finance guard
const MAX_FILES = 50

export interface RecordsImportResult {
  success: boolean
  canceled?: boolean
  error?: string
  imported: number
  duplicates: number
  perFile: Array<{ file: string; recognizer: string | null; imported: number; duplicates: number }>
  unrecognized: string[]
}

type RecordRow = typeof records.$inferSelect

function rowToRecord(row: RecordRow) {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    occurredAt: row.occurredAt ? row.occurredAt.getTime() : null,
    title: row.title,
    body: row.body,
    payload: row.payload,
    provenance: row.provenance,
    ingestedAt: row.ingestedAt ? row.ingestedAt.getTime() : null
  }
}

/** Insert a batch of parsed records, deduping by content hash. Returns counts. */
function insertRecords(inputs: RecordInput[], provenance: string): { imported: number } {
  const db = getDb()
  let imported = 0
  for (const inp of inputs) {
    const res = db
      .insert(records)
      .values({
        source: inp.source,
        type: inp.type,
        occurredAt: inp.occurredAt != null ? new Date(inp.occurredAt) : null,
        title: inp.title.slice(0, 2000),
        body: inp.body ? inp.body.slice(0, 2000) : null,
        payload: inp.payload !== undefined ? JSON.stringify(inp.payload).slice(0, 100_000) : null,
        dedupHash: hashRecord(inp.source, inp.type, inp.occurredAt, inp.naturalKey),
        provenance
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) imported++
  }
  return { imported }
}

/** Core ingest shared by the dialog + drag-drop handlers. */
function ingestFiles(paths: string[]): RecordsImportResult {
  const perFile: RecordsImportResult['perFile'] = []
  const unrecognized: string[] = []
  let imported = 0
  let duplicates = 0

  for (const fp of paths) {
    const name = basename(fp)
    try {
      if (statSync(fp).size > MAX_IMPORT_BYTES) {
        unrecognized.push(`${name} (too large, max 50 MB)`)
        perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
        continue
      }
      const text = readFileSync(fp, 'utf-8').replace(/^﻿/, '')
      const ext = extname(name).slice(1).toLowerCase()
      const rec = recognize({ name, ext, text })
      if (!rec) {
        unrecognized.push(name)
        perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
        continue
      }
      const inputs = rec.parse({ name, ext, text })
      const { imported: imp } = insertRecords(inputs, name)
      const dup = inputs.length - imp
      imported += imp
      duplicates += dup
      perFile.push({ file: name, recognizer: rec.id, imported: imp, duplicates: dup })
    } catch (err) {
      unrecognized.push(`${name} (${String(err)})`)
      perFile.push({ file: name, recognizer: null, imported: 0, duplicates: 0 })
    }
  }

  if (imported > 0) {
    try {
      updateRecordsKnowledge()
    } catch {
      /* knowledge refresh is best-effort */
    }
  }
  return { success: true, imported, duplicates, perFile, unrecognized }
}

const CSV_HEADERS = ['occurred_at', 'source', 'type', 'title', 'body']

/** All records as a CSV string, newest first. Shared with the Export Center. */
export function buildRecordsCsv(): string {
  const db = getDb()
  const rows = db.select().from(records).orderBy(desc(records.occurredAt)).all()
  return serializeCsv(
    rows.map((r) => ({
      occurred_at: r.occurredAt ? r.occurredAt.toISOString() : '',
      source: r.source,
      type: r.type,
      title: r.title,
      body: r.body ?? ''
    })),
    CSV_HEADERS
  )
}

const EMPTY: Omit<RecordsImportResult, 'success'> = {
  imported: 0,
  duplicates: 0,
  perFile: [],
  unrecognized: []
}

export function registerRecordsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'records:list',
    (_event, opts?: { source?: string; type?: string; limit?: number; offset?: number }) => {
      const db = getDb()
      const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 200), 1), 1000)
      const offset = Math.max(Math.trunc(opts?.offset ?? 0), 0)
      const conds: SQL[] = []
      if (opts?.source) conds.push(eq(records.source, opts.source))
      if (opts?.type) conds.push(eq(records.type, opts.type))
      const rows = db
        .select()
        .from(records)
        .where(and(...conds))
        .orderBy(desc(records.occurredAt), desc(records.id))
        .limit(limit)
        .offset(offset)
        .all()
      return rows.map(rowToRecord)
    }
  )

  ipcMain.handle('records:import', async (): Promise<RecordsImportResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import a data export (CSV / JSON)',
      filters: [{ name: 'Data exports', extensions: ['csv', 'json'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true, ...EMPTY }
    return ingestFiles(filePaths.slice(0, MAX_FILES))
  })

  ipcMain.handle('records:import-paths', (_event, paths: string[]): RecordsImportResult => {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { success: false, error: 'No files provided', ...EMPTY }
    }
    return ingestFiles(paths.filter((p) => typeof p === 'string').slice(0, MAX_FILES))
  })
}
