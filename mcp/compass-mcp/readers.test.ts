/**
 * Tests for the expanded-MCP-surface readers (Phase 7 Track C): range
 * normalization/validation and the two query helpers against a real
 * in-memory SQLite mirroring the app schema's relevant columns.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTACT_QUERY_MAX,
  MAX_RECENT_NOTES,
  MAX_TASK_RANGE_DAYS,
  TIMELINE_SEARCH_MAX,
  TRANSACTIONS_MAX,
  normalizeTaskRange,
  readContacts,
  readHealthSummary,
  readLabResults,
  readMedicalRecords,
  readPaystubs,
  readRecentNotes,
  readTasksRange,
  readTimelineSearch,
  readTimelineSummary,
  readTransactions
} from './readers.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL,
      list_date TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'personal',
      checked INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual'
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      last_modified INTEGER,
      word_count INTEGER DEFAULT 0
    );
  `)
})

afterEach(() => {
  db.close()
})

const NOW = new Date('2026-06-15T12:00:00')

describe('normalizeTaskRange', () => {
  it('defaults to a rolling week from today', () => {
    expect(normalizeTaskRange(undefined, undefined, NOW)).toEqual({
      ok: true,
      from: '2026-06-15',
      to: '2026-06-21'
    })
  })

  it('rejects malformed dates, inverted ranges, and oversized ranges', () => {
    expect(normalizeTaskRange('june 1', undefined, NOW).ok).toBe(false)
    expect(normalizeTaskRange('2026-06-15', '2026-06-10', NOW).ok).toBe(false)
    const big = normalizeTaskRange('2026-01-01', '2026-12-31', NOW)
    expect(big).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${MAX_TASK_RANGE_DAYS}`)
    })
  })
})

describe('readTasksRange', () => {
  function addTask(date: string, title: string, checked = 0, listType = 'daily'): void {
    db.prepare(
      'INSERT INTO checklist_items (list_type, list_date, title, checked) VALUES (?, ?, ?, ?)'
    ).run(listType, date, title, checked)
  }

  it('returns daily tasks in the range ordered by date, excluding other list types', () => {
    addTask('2026-06-16', 'tomorrow')
    addTask('2026-06-15', 'today done', 1)
    addTask('2026-06-22', 'next week')
    addTask('2026-06-15', 'weekly item', 0, 'weekly')

    const rows = readTasksRange(db, '2026-06-15', '2026-06-21')
    expect(rows.map((r) => r.title)).toEqual(['today done', 'tomorrow'])
    expect(rows[0].listDate).toBe('2026-06-15')
  })

  it('filters out checked tasks when includeChecked is false', () => {
    addTask('2026-06-15', 'done', 1)
    addTask('2026-06-15', 'open', 0)
    const rows = readTasksRange(db, '2026-06-15', '2026-06-15', false)
    expect(rows.map((r) => r.title)).toEqual(['open'])
  })
})

describe('readRecentNotes', () => {
  function addNote(path: string, title: string, lastModified: number | null): void {
    db.prepare('INSERT INTO knowledge_files (path, title, last_modified) VALUES (?, ?, ?)').run(
      path,
      title,
      lastModified
    )
  }

  it('returns newest-first, skips never-modified rows, and caps the limit', () => {
    addNote('a.md', 'Oldest', 1000)
    addNote('b.md', 'Newest', 3000)
    addNote('c.md', 'Middle', 2000)
    addNote('d.md', 'No timestamp', null)

    const rows = readRecentNotes(db, 2)
    expect(rows.map((r) => r.title)).toEqual(['Newest', 'Middle'])

    // Pathological limits clamp instead of throwing.
    expect(readRecentNotes(db, 9999)).toHaveLength(3)
    expect(readRecentNotes(db, -5)).toHaveLength(1)
    expect(MAX_RECENT_NOTES).toBe(50)
  })
})

describe('readTimelineSummary', () => {
  function createRecords(): void {
    db.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
        occurred_at INTEGER, title TEXT
      );
    `)
  }

  it('returns an empty summary when the records table does not exist', () => {
    // The shared setup creates no `records` table (older DB before the migration).
    expect(readTimelineSummary(db)).toEqual({
      total: 0,
      sources: [],
      kinds: [],
      span: null,
      byYear: []
    })
  })

  it('aggregates by source, kind, and UTC year — never raw titles', () => {
    createRecords()
    const ins = db.prepare(
      'INSERT INTO records (source, type, occurred_at, title) VALUES (?, ?, ?, ?)'
    )
    ins.run('paypal', 'payment', Date.UTC(2019, 5, 15), 'Coffee — 4.50 USD')
    ins.run('venmo', 'payment', Date.UTC(2019, 8, 1), 'Split dinner')
    ins.run('netflix', 'watch', Date.UTC(2022, 0, 3), 'Some Show')
    ins.run('amazon', 'order', null, 'Undated order') // excluded from span/byYear

    const out = readTimelineSummary(db)
    expect(out.total).toBe(4)
    expect(out.kinds.find((k) => k.kind === 'payment')?.count).toBe(2)
    expect(out.sources.find((s) => s.source === 'paypal')?.count).toBe(1)
    expect(out.span).toEqual({ earliestYear: 2019, latestYear: 2022 })
    expect(out.byYear).toEqual([
      { year: 2019, count: 2 },
      { year: 2022, count: 1 }
    ])
    // Content-light invariant: no record titles in the summary.
    expect(JSON.stringify(out)).not.toContain('Coffee')
  })

  it('returns an empty summary for an existing-but-empty records table', () => {
    createRecords()
    expect(readTimelineSummary(db).total).toBe(0)
  })
})

describe('readTimelineSearch (raw timeline retrieval — Phase 10.7)', () => {
  function createFts(): void {
    db.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
        title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    `)
  }
  function add(
    source: string,
    type: string,
    title: string,
    occurredAt: number | null,
    body?: string
  ): void {
    db.prepare(
      'INSERT INTO records (source,type,occurred_at,title,body,dedup_hash) VALUES (?,?,?,?,?,?)'
    ).run(source, type, occurredAt, title, body ?? null, `${source}|${title}`)
  }

  it('returns the actual matching records with date / source / kind / title', () => {
    createFts()
    add('amazon', 'order', 'Echo Dot', Date.UTC(2021, 2, 1), 'smart speaker')
    add('netflix', 'watch', 'The Matrix', Date.UTC(2022, 5, 1))
    const res = readTimelineSearch(db, { q: 'echo' })
    expect(res.count).toBe(1)
    expect(res.records[0]).toMatchObject({
      source: 'amazon',
      type: 'order',
      title: 'Echo Dot',
      date: '2021-03-01',
      detail: 'smart speaker'
    })
  })

  it('honors source + date filters', () => {
    createFts()
    add('amazon', 'order', 'Coffee beans', Date.UTC(2020, 0, 1))
    add('venmo', 'payment', 'Coffee with Sam', Date.UTC(2024, 0, 1))
    expect(
      readTimelineSearch(db, { q: 'coffee', source: 'amazon' }).records.map((r) => r.title)
    ).toEqual(['Coffee beans'])
    expect(
      readTimelineSearch(db, { q: 'coffee', from: '2023-01-01' }).records.map((r) => r.title)
    ).toEqual(['Coffee with Sam'])
  })

  it(`caps results at ${TIMELINE_SEARCH_MAX} and flags more`, () => {
    createFts()
    for (let i = 0; i < 40; i++) add('email', 'email', `Meeting notes ${i}`, null)
    const res = readTimelineSearch(db, { q: 'meeting', limit: 999 })
    expect(res.count).toBeLessThanOrEqual(TIMELINE_SEARCH_MAX)
    expect(res.note).toBeTruthy()
  })

  it('drops firehose sources by default; includeFirehose or a source filter restores them', () => {
    createFts()
    add('generic', 'event', 'TemperatureSensor coffee ping', null)
    add('browser', 'visit', 'Coffee — Wikipedia', Date.UTC(2026, 0, 1))
    add('amazon', 'order', 'Coffee beans', Date.UTC(2020, 0, 1))
    expect(readTimelineSearch(db, { q: 'coffee' }).records.map((r) => r.source)).toEqual(['amazon'])
    expect(readTimelineSearch(db, { q: 'coffee', includeFirehose: true }).count).toBe(3)
    expect(
      readTimelineSearch(db, { q: 'coffee', source: 'browser' }).records.map((r) => r.source)
    ).toEqual(['browser'])
  })

  it('falls back gracefully when the FTS index / records table is absent (legacy DB)', () => {
    // No createFts() — mirrors a DB that predates the Converse migration.
    const res = readTimelineSearch(db, { q: 'anything' })
    expect(res).toMatchObject({ count: 0, records: [] })
    expect(res.note).toBeTruthy()
  })

  it('returns nothing for an empty query (no FTS syntax error)', () => {
    createFts()
    expect(readTimelineSearch(db, { q: '   ' })).toMatchObject({ count: 0, records: [] })
  })
})

// ── Full-detail readers (data-access policy) ─────────────────────────────────

describe('readTransactions', () => {
  function createTxns(): void {
    db.exec(`
      CREATE TABLE finance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, date TEXT NOT NULL, amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD', description TEXT NOT NULL DEFAULT '', category TEXT
      );
    `)
  }
  function add(date: string, amount: number, description: string, category = 'Dining'): void {
    db.prepare(
      'INSERT INTO finance_transactions (date, amount, description, category) VALUES (?,?,?,?)'
    ).run(date, amount, description, category)
  }

  it('returns individual rows newest-first with filters', () => {
    createTxns()
    add('2026-06-01', -6.5, 'STARBUCKS')
    add('2026-06-15', -42, 'WHOLE FOODS', 'Groceries')
    add('2026-05-20', -9, 'STARBUCKS RESERVE')
    const all = readTransactions(db, {})
    expect(all.transactions.map((t) => t.description)).toEqual([
      'WHOLE FOODS',
      'STARBUCKS',
      'STARBUCKS RESERVE'
    ])
    expect(readTransactions(db, { month: '2026-06' }).count).toBe(2)
    expect(readTransactions(db, { q: 'starbucks' }).count).toBe(2)
    expect(readTransactions(db, { category: 'Groceries' }).count).toBe(1)
    expect(readTransactions(db, { from: '2026-06-10' }).count).toBe(1)
  })

  it('ignores from/to when month is provided', () => {
    createTxns()
    add('2026-06-01', -6.5, 'STARBUCKS')
    add('2026-06-15', -42, 'WHOLE FOODS', 'Groceries')
    const result = readTransactions(db, { month: '2026-06', from: '2026-06-10', to: '2026-06-12' })
    expect(result.count).toBe(2)
    expect(result.transactions.map((t) => t.date)).toEqual(['2026-06-15', '2026-06-01'])
  })

  it('rejects malformed month/date filters', () => {
    createTxns()
    expect(readTransactions(db, { month: 'June' }).error).toBeTruthy()
    expect(readTransactions(db, { from: 'nope' }).error).toBeTruthy()
  })

  it(`caps at ${TRANSACTIONS_MAX} and guards the absent table (older DB)`, () => {
    expect(readTransactions(db, {})).toMatchObject({ count: 0, transactions: [] })
    createTxns()
    for (let i = 0; i < 60; i++) add('2026-06-01', -1, `txn ${i}`)
    const res = readTransactions(db, { limit: 999 })
    expect(res.count).toBe(TRANSACTIONS_MAX)
    expect(res.note).toBeTruthy()
  })
})

describe('readContacts', () => {
  function createContacts(): void {
    db.exec(`
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        org TEXT, job_title TEXT, relationship TEXT, search_blob TEXT, photo TEXT, enrichment TEXT,
        emails TEXT, phones TEXT
      );
    `)
  }

  it('matches on the search blob and returns the light shape (never photo/enrichment)', () => {
    createContacts()
    db.prepare(
      `INSERT INTO contacts (external_id, display_name, org, job_title, relationship, search_blob, photo, emails, phones, enrichment)
       VALUES ('c1', 'Jane Doe', 'Acme', 'CTO', 'colleague', 'jane doe acme jane@example.com', 'data:image/png;base64,xxx',
               '[{"type":"work","value":"jane@example.com"}]', '[{"value":"+1 415 555 0100"}]',
               '{"crossSource":{"lastSeen":1700000000000,"touchpointCount":4}}')`
    ).run()
    const hits = readContacts(db, 'jane')
    expect(hits).toEqual([
      {
        id: 1,
        displayName: 'Jane Doe',
        org: 'Acme',
        jobTitle: 'CTO',
        relationship: 'colleague',
        emails: ['jane@example.com'],
        phones: ['+1 415 555 0100'],
        lastSeen: 1700000000000
      }
    ])
  })

  it('degrades cleanly without enrichment or identifier values', () => {
    createContacts()
    db.prepare(
      `INSERT INTO contacts (external_id, display_name, search_blob, emails)
       VALUES ('c3', 'No Data', 'no data', 'not-json')`
    ).run()
    expect(readContacts(db, 'no data')).toEqual([
      {
        id: 1,
        displayName: 'No Data',
        org: null,
        jobTitle: null,
        relationship: null,
        emails: [],
        phones: [],
        lastSeen: null
      }
    ])
  })

  it('guards the absent table and empty queries', () => {
    expect(readContacts(db, 'jane')).toEqual([])
    createContacts()
    expect(readContacts(db, '   ')).toEqual([])
  })

  it('caps search query length', () => {
    createContacts()
    const cappedNeedle = 'a'.repeat(CONTACT_QUERY_MAX)
    db.prepare(
      'INSERT INTO contacts (external_id, display_name, search_blob) VALUES (?, ?, ?)'
    ).run('c2', 'Cap Test', cappedNeedle)
    expect(readContacts(db, 'a'.repeat(CONTACT_QUERY_MAX + 200))).toHaveLength(1)
  })
})

describe('readMedicalRecords', () => {
  function createMedical(): void {
    db.exec(`
      CREATE TABLE medical_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
        description TEXT, code TEXT, status TEXT, recorded_at TEXT
      );
    `)
  }

  it('returns FULL clinical rows with filters (the counts-only wall is gone)', () => {
    createMedical()
    db.prepare(
      "INSERT INTO medical_records (external_id, category, description, code, status, recorded_at) VALUES ('m1','medication','Aspirin 81mg','RxNorm:243670','active','2026-03-10')"
    ).run()
    db.prepare(
      "INSERT INTO medical_records (external_id, category, description, status) VALUES ('m2','condition','Migraine','resolved')"
    ).run()
    const all = readMedicalRecords(db, {})
    expect(all.count).toBe(2)
    expect(all.records[0]).toMatchObject({
      category: 'medication',
      description: 'Aspirin 81mg',
      code: 'RxNorm:243670',
      status: 'active',
      recordedAt: '2026-03-10'
    })
    expect(readMedicalRecords(db, { category: 'condition' }).count).toBe(1)
    expect(readMedicalRecords(db, { status: 'ACTIVE' }).count).toBe(1)
    const filtered = readMedicalRecords(db, { category: 'medication', status: 'active' })
    expect(filtered.records).toHaveLength(1)
    expect(filtered.count).toBe(1)
    expect(filtered.records[0]).toMatchObject({ category: 'medication', status: 'active' })
    expect(readMedicalRecords(db, { category: 'surgery' }).error).toBeTruthy()
  })

  it('guards the absent table (older DB)', () => {
    expect(readMedicalRecords(db, {})).toMatchObject({ count: 0, records: [] })
  })
})

describe('readLabResults', () => {
  function createLabResults(): void {
    db.exec(`
      CREATE TABLE lab_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, test_name TEXT NOT NULL, panel TEXT, value REAL,
        value_text TEXT, unit TEXT, ref_range TEXT, flag TEXT, taken_at TEXT NOT NULL,
        encounter_id TEXT
      );
    `)
  }

  it('returns quantitative rows with testName/panel filters', () => {
    createLabResults()
    db.prepare(
      "INSERT INTO lab_results (test_name, panel, value, unit, ref_range, flag, taken_at) VALUES ('Cholesterol', 'Coronary Risk Profile', 305, 'mg/dL', '<200 mg/dL', 'high', '2026-04-17')"
    ).run()
    db.prepare(
      "INSERT INTO lab_results (test_name, panel, value, unit, flag, taken_at) VALUES ('Sodium', 'Chem 7 Profile', 137, 'mmol/L', 'normal', '2026-04-17')"
    ).run()
    const all = readLabResults(db, {})
    expect(all.count).toBe(2)
    expect(all.records[0]).toMatchObject({
      testName: 'Cholesterol',
      panel: 'Coronary Risk Profile',
      value: 305,
      unit: 'mg/dL',
      refRange: '<200 mg/dL',
      flag: 'high',
      takenAt: '2026-04-17'
    })
    expect(readLabResults(db, { testName: 'chol' }).count).toBe(1)
    expect(readLabResults(db, { panel: 'Chem 7 Profile' }).count).toBe(1)
  })

  it('guards the absent table (older DB)', () => {
    expect(readLabResults(db, {})).toMatchObject({ count: 0, records: [] })
  })
})

describe('readPaystubs', () => {
  it('returns per-stub rows newest-first plus totals, guarding the absent table', () => {
    expect(readPaystubs(db)).toMatchObject({ paystubs: [], totals: null })
    db.exec(`
      CREATE TABLE argyle_paystubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, employer TEXT,
        gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
        currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT, paid_at TEXT
      );
    `)
    db.prepare(
      "INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, paid_at) VALUES ('p1','Initech',4000,3000,'2026-06-16')"
    ).run()
    db.prepare(
      "INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, paid_at) VALUES ('p2','Initech',4000,3010,'2026-06-30')"
    ).run()
    const res = readPaystubs(db)
    expect(res.paystubs.map((p) => p.netPay)).toEqual([3010, 3000])
    expect(res.totals).toMatchObject({ count: 2, totalNet: 6010, totalGross: 8000 })
  })
})

describe('readHealthSummary', () => {
  function createHealthTables(): void {
    db.exec(`
      CREATE TABLE oura_daily_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
        sleep_score INTEGER, readiness_score INTEGER, activity_score INTEGER,
        steps INTEGER, total_sleep_minutes INTEGER
      );
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
        occurred_at INTEGER, title TEXT NOT NULL, body TEXT, payload TEXT,
        dedup_hash TEXT NOT NULL UNIQUE, provenance TEXT, ingested_at INTEGER
      );
    `)
  }
  let recSeq = 0
  function addRecord(source: string, type: string, occurredAt: number, payload: unknown): void {
    recSeq++
    db.prepare(
      'INSERT INTO records (source, type, occurred_at, title, payload, dedup_hash) VALUES (?,?,?,?,?,?)'
    ).run(source, type, occurredAt, `${source} ${type}`, JSON.stringify(payload), `hs-${recSeq}`)
  }
  /** epoch ms for a local YYYY-MM-DD midnight — the exact shape `records.occurred_at` stores. */
  function ymdMs(ymd: string): number {
    return new Date(`${ymd}T00:00:00`).getTime()
  }

  it('aggregates epoch-ms apple-health records (regression: localYmd was fed a number)', () => {
    createHealthTables()
    addRecord('apple-health', 'resting-hr', ymdMs('2026-06-14'), { value: 55 })
    addRecord('apple-health', 'sleep', ymdMs('2026-06-14'), { ms: 8 * 3_600_000 })
    addRecord('apple-health', 'steps', ymdMs('2026-06-13'), { value: 9000 })
    addRecord('apple-health', 'workout', ymdMs('2026-06-10'), {})

    const s = readHealthSummary(db, NOW)
    expect(s.today).toBe('2026-06-15')
    expect(s.sources).toEqual({ oura: false, appleHealth: true, fitbit: false, garmin: false })
    expect(s.restingHrLatest).toBe(55)
    expect(s.restingHrAvg30).toBe(55)
    expect(s.sleepMinutesAvg7).toBe(480)
    expect(s.stepsAvg7).toBe(9000)
    expect(s.workouts30).toBe(1)
    expect(s.activeDays30).toBe(2) // workout day + ≥8000-step day
  })

  it('blends Oura daily metrics and reports the latest scores', () => {
    createHealthTables()
    db.prepare(
      "INSERT INTO oura_daily_metrics (date, sleep_score, readiness_score, activity_score, steps, total_sleep_minutes) VALUES ('2026-06-13', 70, 75, 80, 6000, 400)"
    ).run()
    db.prepare(
      "INSERT INTO oura_daily_metrics (date, sleep_score, readiness_score, activity_score, steps, total_sleep_minutes) VALUES ('2026-06-14', 80, 85, 90, 12000, 440)"
    ).run()

    const s = readHealthSummary(db, NOW)
    expect(s.sources.oura).toBe(true)
    expect(s.oura).toMatchObject({
      latestDate: '2026-06-14',
      sleepScore: 80,
      readinessScore: 85,
      sleepScore7Avg: 75,
      readiness7Avg: 80
    })
    expect(s.sleepMinutesAvg7).toBe(420)
    expect(s.activeDays30).toBe(1) // only the 12000-step day crosses 8000
  })

  it('returns an empty summary when the health tables are absent (older DB)', () => {
    const s = readHealthSummary(db, NOW)
    expect(s.today).toBe('2026-06-15')
    expect(s.sources).toEqual({ oura: false, appleHealth: false, fitbit: false, garmin: false })
    expect(s.oura).toBeNull()
    expect(s.stepsAvg7).toBeNull()
    expect(s.restingHrLatest).toBeNull()
    expect(s.workouts30).toBe(0)
    expect(s.activeDays30).toBe(0)
  })
})
