import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLatestRates, syncFxRates } from './finance-fx-fetch'

// A minimal er-api success payload. Includes USD (must be skipped), the user's
// real currencies, and a garbage entry (0) that must be filtered out.
const OK_PAYLOAD = {
  result: 'success',
  base_code: 'USD',
  rates: { USD: 1, CRC: 512.3, EUR: 0.92, COP: 4000, MXN: 0, GBP: 0.79, CAD: 1.36 }
}

function mockFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload
  })) as unknown as typeof fetch
}

describe('fetchLatestRates', () => {
  it('returns USD-anchored rates for supported currencies, skipping USD + invalid', async () => {
    const rates = await fetchLatestRates({ fetchImpl: mockFetch(OK_PAYLOAD) })
    // USD skipped; MXN (0) filtered → CRC, EUR, COP, GBP, CAD remain.
    const quotes = rates.map((r) => r.quote).sort()
    expect(quotes).toEqual(['CAD', 'COP', 'CRC', 'EUR', 'GBP'])
    expect(rates.every((r) => r.base === 'USD')).toBe(true)
    expect(rates.find((r) => r.quote === 'CRC')?.rate).toBe(512.3)
  })

  it('hits the pinned open.er-api.com host with the USD anchor', async () => {
    const spy = mockFetch(OK_PAYLOAD)
    await fetchLatestRates({ fetchImpl: spy })
    expect(spy).toHaveBeenCalledWith('https://open.er-api.com/v6/latest/USD')
  })

  it('throws on a non-2xx response', async () => {
    await expect(
      fetchLatestRates({ fetchImpl: mockFetch({}, { ok: false, status: 503 }) })
    ).rejects.toThrow(/HTTP 503/)
  })

  it('throws on a provider error result', async () => {
    await expect(
      fetchLatestRates({
        fetchImpl: mockFetch({ result: 'error', 'error-type': 'unsupported-code' })
      })
    ).rejects.toThrow(/provider error/)
  })

  it('throws when the body is missing rates', async () => {
    await expect(fetchLatestRates({ fetchImpl: mockFetch({ result: 'success' }) })).rejects.toThrow(
      /missing rates/
    )
  })
})

describe('syncFxRates', () => {
  let sqlite: Database.Database
  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE fx_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
        rate REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', fetched_at INTEGER
      );
      CREATE UNIQUE INDEX uq_fx_rates_date_base_quote ON fx_rates (date, base, quote);
    `)
  })

  it('persists fetched rates tagged source=erapi and returns the count + date', async () => {
    const res = await syncFxRates(sqlite, {
      fetchImpl: mockFetch(OK_PAYLOAD),
      date: '2026-06-27'
    })
    expect(res).toEqual({ updated: 5, date: '2026-06-27' })
    const rows = sqlite
      .prepare('SELECT base, quote, rate, source FROM fx_rates ORDER BY quote')
      .all() as Array<{ base: string; quote: string; rate: number; source: string }>
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.source === 'erapi' && r.base === 'USD')).toBe(true)
    expect(rows.find((r) => r.quote === 'CRC')?.rate).toBe(512.3)
  })

  it('is idempotent within a day — a re-run refreshes in place', async () => {
    await syncFxRates(sqlite, { fetchImpl: mockFetch(OK_PAYLOAD), date: '2026-06-27' })
    await syncFxRates(sqlite, {
      fetchImpl: mockFetch({ result: 'success', rates: { CRC: 515 } }),
      date: '2026-06-27'
    })
    const crc = sqlite
      .prepare("SELECT rate FROM fx_rates WHERE quote = 'CRC' AND date = '2026-06-27'")
      .all() as Array<{ rate: number }>
    expect(crc).toHaveLength(1)
    expect(crc[0].rate).toBe(515)
  })
})
