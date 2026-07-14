/**
 * Tests for the insight discovery engine: the Spearman gates (floor, n-aware
 * bar, split-half stability), the pairwise scan (family exclusion, zero-fill,
 * overlap floors), and the event studies (anchor grouping, before/after means,
 * archive-coverage guard). Real in-memory SQLite, pinned clock.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'

let sqlite: Database.Database

vi.mock('../db/client', () => ({
  getDb: () => drizzle(sqlite, { schema })
}))

const db = () => drizzle(sqlite, { schema })

// 2026-06-15 is a Monday — the current (partial) week; complete weeks end 2026-06-14.
const NOW = new Date('2026-06-15T12:00:00')

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
      occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
    );
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'Uncategorized',
      normalized_merchant TEXT
    );
  `)
})

afterEach(() => {
  sqlite.close()
})

function createMedicalTable(): void {
  sqlite.exec(`CREATE TABLE medical_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
    description TEXT, code TEXT, status TEXT, recorded_at TEXT, ingested_at INTEGER
  );`)
}
function createTravelTable(): void {
  sqlite.exec(`CREATE TABLE travel_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, start_date TEXT NOT NULL,
    end_date TEXT NOT NULL, notes TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER
  );`)
}

let recSeq = 0
function addRecord(source: string, type: string, occurredAtMs: number, payload?: unknown): void {
  recSeq++
  sqlite
    .prepare(
      'INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(
      source,
      type,
      occurredAtMs,
      `${source} ${type}`,
      payload === undefined ? null : JSON.stringify(payload),
      `disc-${recSeq}`
    )
}

function ymdMs(ymd: string): number {
  return new Date(`${ymd}T00:00:00`).getTime()
}

/** Monday 'YYYY-MM-DD' `w` COMPLETE weeks before NOW's week (w=1 → 2026-06-08). */
function weekYmd(w: number): string {
  const monday = new Date('2026-06-15T00:00:00')
  monday.setDate(monday.getDate() - w * 7)
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
}

/** Seed `count` rows of a spine metric on one day. */
function seedCount(source: string, type: string, ymd: string, count: number): void {
  for (let i = 0; i < count; i++) addRecord(source, type, ymdMs(ymd))
}

describe('stableSpearman gates', () => {
  it('accepts a clean monotonic relationship', async () => {
    const { stableSpearman } = await import('./insights-discovery')
    const a = new Map<string, number>()
    const b = new Map<string, number>()
    for (let i = 0; i < 10; i++) {
      a.set(`k${i}`, i)
      b.set(`k${i}`, i * 3 + 1)
    }
    expect(stableSpearman(a, b, 8)).toMatchObject({ rho: 1, n: 10 })
  })

  it('rejects weak relationships (|ρ| floor / n-aware bar)', async () => {
    const { stableSpearman } = await import('./insights-discovery')
    const a = new Map<string, number>()
    const b = new Map<string, number>()
    const noise = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8]
    for (let i = 0; i < 12; i++) {
      a.set(`k${String(i).padStart(2, '0')}`, i)
      b.set(`k${String(i).padStart(2, '0')}`, noise[i])
    }
    expect(stableSpearman(a, b, 8)).toBeNull()
  })

  it('rejects a relationship that flips sign between halves', async () => {
    const { stableSpearman } = await import('./insights-discovery')
    const a = new Map<string, number>()
    const b = new Map<string, number>()
    // First 10 buckets ascending together, second 10 anti-correlated: overall
    // ρ≈0.75 clears the n=20 gate, but the halves disagree → coincidence.
    for (let i = 0; i < 20; i++) {
      a.set(`k${String(i).padStart(2, '0')}`, i)
      b.set(`k${String(i).padStart(2, '0')}`, i < 10 ? i : 30 - i)
    }
    expect(stableSpearman(a, b, 8)).toBeNull()
  })

  it('rejects constant series and thin overlap', async () => {
    const { stableSpearman } = await import('./insights-discovery')
    const flat = new Map<string, number>()
    const rising = new Map<string, number>()
    for (let i = 0; i < 10; i++) {
      flat.set(`k${i}`, 5)
      rising.set(`k${i}`, i)
    }
    expect(stableSpearman(flat, rising, 8)).toBeNull()
    const thin = new Map([...rising].slice(0, 5))
    expect(stableSpearman(thin, rising, 8)).toBeNull()
  })
})

describe('buildDiscovery — pairwise scan', () => {
  it('finds a strong cross-family weekly pair and reports its points', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    // 12 complete weeks: browsing (web) and texts (communication) rise together.
    for (let w = 1; w <= 12; w++) {
      seedCount('browser', 'visit', weekYmd(w), w + 1)
      seedCount('google-voice', 'text', weekYmd(w), (w + 1) * 2)
    }
    const d = buildDiscovery(db(), NOW)
    const hit = d.weekly.find((f) => f.id.includes('browsing') && f.id.includes('texts'))
    expect(hit).toBeDefined()
    expect(hit?.rho).toBe(1)
    expect(hit?.n).toBe(12)
    expect(hit?.points).toHaveLength(12)
    expect(hit?.sentence).toMatch(/above-average browsing/)
    expect(d.scanned.weekly).toBeGreaterThan(0)
  })

  it('detects negative relationships', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    for (let w = 1; w <= 12; w++) {
      seedCount('browser', 'visit', weekYmd(w), w + 1)
      seedCount('google-voice', 'text', weekYmd(w), 14 - w)
    }
    const hit = buildDiscovery(db(), NOW).weekly.find(
      (f) => f.id.includes('browsing') && f.id.includes('texts')
    )
    expect(hit?.rho).toBe(-1)
  })

  it('never correlates same-family series (netflix × prime-video)', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    for (let w = 1; w <= 12; w++) {
      seedCount('netflix', 'watch', weekYmd(w), w + 1)
      seedCount('prime-video', 'watch', weekYmd(w), w + 1)
    }
    const d = buildDiscovery(db(), NOW)
    expect(
      d.weekly.find((f) => f.id.includes('netflix') && f.id.includes('prime-video'))
    ).toBeUndefined()
  })

  it('zero-fills count metrics inside their active range (gap weeks count as 0)', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    for (let w = 1; w <= 12; w++) {
      // Browsing has NO rows in weeks 5-6 — real zeros inside its active range.
      if (w !== 5 && w !== 6) seedCount('browser', 'visit', weekYmd(w), 14 - w)
      seedCount('google-voice', 'text', weekYmd(w), w === 5 || w === 6 ? 1 : (14 - w) * 2)
    }
    const hit = buildDiscovery(db(), NOW).weekly.find(
      (f) => f.id.includes('browsing') && f.id.includes('texts')
    )
    expect(hit).toBeDefined()
    expect(hit?.n).toBe(12) // the two zero weeks are IN the series, not dropped
    expect(hit?.points.filter((p) => p.x === 0 || p.y === 0)).toHaveLength(2)
  })

  it('skips pairs below the overlap floor', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    for (let w = 1; w <= 5; w++) {
      seedCount('browser', 'visit', weekYmd(w), w + 1)
      seedCount('google-voice', 'text', weekYmd(w), (w + 1) * 2)
    }
    const d = buildDiscovery(db(), NOW)
    expect(d.weekly).toHaveLength(0)
    expect(d.scanned.weekly).toBe(0)
  })

  it('scans the monthly window across the whole archive', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    // 30 complete months (2023-12 … 2026-05) rising together.
    const d0 = new Date('2023-12-15T12:00:00')
    for (let m = 0; m < 30; m++) {
      const d = new Date(d0)
      d.setMonth(d.getMonth() + m)
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`
      seedCount('netflix', 'watch', ymd, m + 1)
      seedCount('google-voice', 'text', ymd, (m + 1) * 2)
    }
    const hit = buildDiscovery(db(), NOW).monthly.find(
      (f) => f.id.includes('netflix') && f.id.includes('texts')
    )
    expect(hit).toBeDefined()
    expect(hit?.n).toBe(30)
    expect(hit?.window).toBe('monthly')
  })

  it('returns an empty result on an empty DB and survives missing tables', async () => {
    const { buildDiscovery, registerDiscoveryHandlers } = await import('./insights-discovery')
    sqlite.exec('DROP TABLE records; DROP TABLE finance_transactions;')
    const d = buildDiscovery(db(), NOW)
    expect(d.weekly).toEqual([])
    expect(d.monthly).toEqual([])
    expect(d.events).toEqual([])

    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    registerDiscoveryHandlers({
      handle: (channel: string, h: (...args: unknown[]) => unknown) => {
        handlers[channel] = h
      }
    } as unknown as IpcMain)
    expect(handlers['insights:discovery']).toBeDefined()
  })
})

describe('buildDiscovery — event studies', () => {
  /** Steps 10k/day for 28 days before 2026-05-10, 5k/day for 28 days after. */
  function seedStepsAroundMay10(): void {
    for (let i = 1; i <= 28; i++) {
      const before = new Date('2026-05-10T00:00:00')
      before.setDate(before.getDate() - i)
      addRecord('apple-health', 'steps', before.getTime(), { value: 10000 })
      const after = new Date('2026-05-10T00:00:00')
      after.setDate(after.getDate() + i)
      addRecord('apple-health', 'steps', after.getTime(), { value: 5000 })
    }
  }

  it('surfaces before/after deltas around a medical encounter', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    createMedicalTable()
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, recorded_at) VALUES ('m1','encounter','ED visit — chest pain','2026-05-10')"
      )
      .run()
    seedStepsAroundMay10()
    const d = buildDiscovery(db(), NOW)
    expect(d.events).toHaveLength(1)
    expect(d.events[0]).toMatchObject({ kind: 'medical', date: '2026-05-10' })
    const steps = d.events[0].deltas.find((x) => x.id === 'steps')
    expect(steps).toMatchObject({ before: 10000, after: 5000, pctChange: -0.5 })
  })

  it('groups same-episode clinical days into one anchor, preferring the encounter label', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    createMedicalTable()
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, recorded_at) VALUES ('m1','procedure','CT angiography','2026-05-11')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, recorded_at) VALUES ('m2','encounter','ED visit — chest pain','2026-05-10')"
      )
      .run()
    seedStepsAroundMay10()
    const d = buildDiscovery(db(), NOW)
    expect(d.events).toHaveLength(1)
    expect(d.events[0].label).toMatch(/ED visit/)
    expect(d.events[0].date).toBe('2026-05-10')
  })

  it('compares before vs during for travel segments', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    createTravelTable()
    sqlite
      .prepare(
        "INSERT INTO travel_segments (country, start_date, end_date) VALUES ('Costa Rica','2026-05-01','2026-05-14')"
      )
      .run()
    // Browsing 10/day for the 28 days before, 2/day while away.
    for (let i = 1; i <= 28; i++) {
      const before = new Date('2026-05-01T00:00:00')
      before.setDate(before.getDate() - i)
      seedCount(
        'browser',
        'visit',
        `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, '0')}-${String(before.getDate()).padStart(2, '0')}`,
        10
      )
    }
    for (let i = 0; i < 14; i++) {
      const during = new Date('2026-05-01T00:00:00')
      during.setDate(during.getDate() + i)
      seedCount(
        'browser',
        'visit',
        `${during.getFullYear()}-${String(during.getMonth() + 1).padStart(2, '0')}-${String(during.getDate()).padStart(2, '0')}`,
        2
      )
    }
    const d = buildDiscovery(db(), NOW)
    const trip = d.events.find((e) => e.kind === 'travel')
    expect(trip).toBeDefined()
    expect(trip?.label).toBe('Trip to Costa Rica')
    expect(trip?.compareLabel).toMatch(/while away \(14 days\)/)
    const browsing = trip?.deltas.find((x) => x.id === 'browsing')
    expect(browsing).toMatchObject({ before: 10, after: 2, pctChange: -0.8 })
  })

  it('skips metrics whose archive stopped before the event (no fake zeros)', async () => {
    const { buildDiscovery } = await import('./insights-discovery')
    createMedicalTable()
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, recorded_at) VALUES ('m1','encounter','ED visit','2026-05-10')"
      )
      .run()
    seedStepsAroundMay10()
    // Kindle archive ended long before the event — must NOT read as "went to 0".
    for (let i = 0; i < 30; i++)
      seedCount('kindle', 'read', `2023-01-${String((i % 28) + 1).padStart(2, '0')}`, 2)
    const d = buildDiscovery(db(), NOW)
    expect(d.events[0].deltas.find((x) => x.id === 'kindle')).toBeUndefined()
  })
})
