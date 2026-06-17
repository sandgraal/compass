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

/**
 * Find the real header key matching one of `wanted`, comparing case-insensitively
 * and ignoring stray surrounding whitespace. Tries the wanted names in priority
 * order (so `matchHeader(keys, 'Total Owed', 'Item Total')` prefers the first that
 * exists) and returns the actual untrimmed key so callers can index rows by it.
 *
 * Shared by the Drop Zone CSV recognizers (Amazon, PayPal, …) so they tolerate the
 * minor header drift third-party exports produce without each re-rolling the match.
 */
export function matchHeader(keys: string[], ...wanted: string[]): string | undefined {
  const norm = (s: string): string => s.trim().toLowerCase()
  for (const want of wanted) {
    const target = norm(want)
    const hit = keys.find((k) => norm(k) === target)
    if (hit) return hit
  }
  return undefined
}

/**
 * Drop leading preamble lines so parsing starts at the first line containing ALL
 * of `required` (case-insensitive substring). Returns the text unchanged if the
 * header is already line 0, or if no matching line is found. Lets recognizers
 * handle exports (Venmo, LinkedIn, …) that prefix the real CSV header with a
 * title / notes / account-summary block.
 */
export function fromHeaderRow(text: string, ...required: string[]): string {
  const lines = text.split('\n')
  const needles = required.map((t) => t.toLowerCase())
  const idx = lines.findIndex((line) => {
    const lower = line.toLowerCase()
    return needles.every((n) => lower.includes(n))
  })
  return idx <= 0 ? text : lines.slice(idx).join('\n')
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
