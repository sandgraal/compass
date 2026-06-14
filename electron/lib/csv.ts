/**
 * Shared CSV codec (Phase 9 — "The Storehouse").
 *
 * `parseCSV` was originally inlined in `electron/ipc/vault.ts` for the
 * 1Password import. It's lifted here so the contacts importer, the finance
 * ledger export, and the Export Center can all share one audited RFC-4180
 * implementation instead of re-rolling the quote/escape edge cases.
 */

/** Minimal RFC-4180 CSV parser — handles quoted fields with embedded commas/newlines. */
export function parseCSV(raw: string): Record<string, string>[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) return []

  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]

    if (char === '"') {
      if (inQuotes && normalized[i + 1] === '"') {
        field += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      record.push(field)
      field = ''
      continue
    }

    if (char === '\n' && !inQuotes) {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      continue
    }

    field += char
  }

  record.push(field)
  records.push(record)

  if (records.length < 2) return []

  const headers = records[0]
  const result: Record<string, string>[] = []

  for (let r = 1; r < records.length; r++) {
    const vals = records[r]
    if (vals.length === 1 && !vals[0].trim()) continue

    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = vals[i] ?? ''
    })
    result.push(row)
  }

  return result
}

/** Escape a single CSV field — quote it when it contains a comma, quote, or newline. */
export function csvEscape(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Serialize rows to RFC-4180 CSV. `headers` fixes the column order; each row is
 * read by header key. Uses CRLF line endings (the RFC-4180 default, friendliest
 * to spreadsheet apps on every platform).
 */
export function serializeCsv(rows: Array<Record<string, unknown>>, headers: string[]): string {
  const lines: string[] = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
