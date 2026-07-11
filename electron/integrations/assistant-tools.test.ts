/**
 * Tests for the embedded-agent tool layer (Phase 8.5).
 *
 * Real in-memory SQLite + drizzle (same pattern as habits/claude tests). We
 * exercise the read tools' shapes and — most importantly — that propose_task
 * ENQUEUES a pending claude_proposals row rather than mutating anything.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { ASSISTANT_TOOLS, executeAssistantTool } from './assistant-tools'

let sqlite: Database.Database
function db() {
  return drizzle(sqlite, { schema })
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, list_type TEXT NOT NULL, list_date TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, checked INTEGER DEFAULT 0, status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal', sort_order INTEGER DEFAULT 0, due_date TEXT,
      source TEXT DEFAULT 'manual', source_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, source_id TEXT, title TEXT,
      start_at INTEGER, end_at INTEGER, all_day INTEGER, location TEXT, description TEXT,
      url TEXT, created_at INTEGER
    );
    CREATE TABLE finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, is_debt INTEGER DEFAULT 0,
      asset_class TEXT, balance REAL, payment_due_date TEXT
    , is_foreign INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, amount REAL, category TEXT,
      description TEXT DEFAULT '', currency TEXT DEFAULT 'USD'
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      given_name TEXT, family_name TEXT, middle_name TEXT, prefix TEXT, suffix TEXT, org TEXT, job_title TEXT,
      phones TEXT, emails TEXT, addresses TEXT, birthday TEXT, url TEXT, relationship TEXT, notes TEXT,
      photo TEXT, source TEXT NOT NULL DEFAULT 'manual', search_blob TEXT, enrichment TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
      description TEXT, code TEXT, status TEXT, recorded_at TEXT, ingested_at INTEGER
    );
    CREATE TABLE argyle_paystubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, employer TEXT,
      gross_pay REAL, net_pay REAL, withholding REAL, deductions REAL,
      currency TEXT NOT NULL DEFAULT 'USD', period_start TEXT, period_end TEXT, paid_at TEXT,
      pay_cycle TEXT, ingested_at INTEGER
    );
    CREATE TABLE claude_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      payload TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'claude-mcp', status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, ingested_at INTEGER NOT NULL, resolved_at INTEGER, error TEXT,
      result_ref TEXT, cleared_at INTEGER
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT, color TEXT,
      active INTEGER DEFAULT 1, created_at INTEGER,
      auto_link_source TEXT, auto_link_threshold REAL
    );
    CREATE TABLE habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, date TEXT NOT NULL,
      completed INTEGER DEFAULT 0, source TEXT
    );
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      category TEXT, last_modified INTEGER, word_count INTEGER DEFAULT 0, auto_updated INTEGER DEFAULT 0
    );
  `)
})

afterEach(() => sqlite.close())

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('ASSISTANT_TOOLS', () => {
  it('advertises read + propose tools with input schemas', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name)
    expect(names).toContain('get_upcoming')
    expect(names).toContain('get_finance_summary')
    expect(names).toContain('list_transactions')
    expect(names).toContain('search_contacts')
    expect(names).toContain('get_contact')
    expect(names).toContain('get_medical_records')
    expect(names).toContain('get_paystubs')
    expect(names).toContain('search_vault')
    expect(names).toContain('get_vault_entry')
    expect(names).toContain('get_week_tasks')
    expect(names).toContain('get_weekly_goals')
    expect(names).toContain('get_habit_streaks')
    expect(names).toContain('get_insights')
    expect(names).toContain('get_timeline')
    expect(names).toContain('search_records')
    expect(names).toContain('propose_task')
    for (const t of ASSISTANT_TOOLS) expect(t.input_schema.type).toBe('object')
  })

  it('never offers the credentials vault category in any tool schema', () => {
    // The enums on search_vault/get_vault_entry are the policy surface the
    // model sees — credentials must not be selectable.
    const json = JSON.stringify(ASSISTANT_TOOLS)
    expect(json).not.toContain("'credentials'")
    expect(json).not.toContain('"credentials"')
  })
})

describe('search_records (raw timeline retrieval — Phase 10.7)', () => {
  beforeEach(() => {
    sqlite.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
        title TEXT NOT NULL, body TEXT, payload TEXT, dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
      );
      CREATE VIRTUAL TABLE records_fts USING fts5(title, body, payload, content='records', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN INSERT INTO records_fts(rowid,title,body,payload) VALUES (new.id,new.title,new.body,new.payload); END;
    `)
  })
  function addRecord(r: {
    source: string
    type: string
    title: string
    body?: string
    occurredAt?: number
  }): void {
    sqlite
      .prepare(
        'INSERT INTO records (source,type,occurred_at,title,body,dedup_hash) VALUES (?,?,?,?,?,?)'
      )
      .run(
        r.source,
        r.type,
        r.occurredAt ?? null,
        r.title,
        r.body ?? null,
        `${r.source}|${r.title}`
      )
  }
  // biome-ignore lint/suspicious/noExplicitAny: terse access to the tagged tool result in assertions
  const data = (res: unknown): any => (res as { data: unknown }).data

  it('returns the ACTUAL matching records (date / source / kind / title / detail)', () => {
    addRecord({
      source: 'amazon',
      type: 'order',
      title: 'Echo Dot',
      body: 'smart speaker',
      occurredAt: Date.parse('2021-03-01T00:00:00Z')
    })
    addRecord({ source: 'netflix', type: 'watch', title: 'The Matrix' })
    const res = executeAssistantTool(db(), sqlite, 'search_records', { q: 'echo' })
    expect(res.ok).toBe(true)
    expect(data(res).count).toBe(1)
    expect(data(res).records[0]).toMatchObject({
      title: 'Echo Dot',
      source: 'amazon',
      type: 'order',
      date: '2021-03-01',
      detail: 'smart speaker'
    })
  })

  it('honors source / date filters and rejects a bad date', () => {
    addRecord({
      source: 'amazon',
      type: 'order',
      title: 'Coffee beans',
      occurredAt: Date.parse('2020-01-01T00:00:00Z')
    })
    addRecord({
      source: 'venmo',
      type: 'payment',
      title: 'Coffee with Sam',
      occurredAt: Date.parse('2024-01-01T00:00:00Z')
    })
    expect(
      data(
        executeAssistantTool(db(), sqlite, 'search_records', { q: 'coffee', source: 'amazon' })
      ).records.map((r: { title: string }) => r.title)
    ).toEqual(['Coffee beans'])
    expect(
      data(
        executeAssistantTool(db(), sqlite, 'search_records', { q: 'coffee', from: '2023-01-01' })
      ).records.map((r: { title: string }) => r.title)
    ).toEqual(['Coffee with Sam'])
    expect(
      executeAssistantTool(db(), sqlite, 'search_records', { q: 'coffee', from: 'nope' }).ok
    ).toBe(false)
  })

  it('caps the result count (≤25) and flags that there may be more', () => {
    for (let i = 0; i < 40; i++)
      addRecord({ source: 'email', type: 'email', title: `Meeting notes ${i}` })
    const res = executeAssistantTool(db(), sqlite, 'search_records', { q: 'meeting', limit: 999 })
    expect(data(res).records.length).toBeLessThanOrEqual(25)
    expect(data(res).note).toBeTruthy()
  })

  it('caps each detail line (no unbounded body dump) and never returns payload', () => {
    addRecord({ source: 'email', type: 'email', title: 'Long one', body: 'x'.repeat(5000) })
    const rec = data(executeAssistantTool(db(), sqlite, 'search_records', { q: 'long' })).records[0]
    expect(rec.detail.length).toBeLessThanOrEqual(200)
    expect('payload' in rec).toBe(false)
  })

  it('requires a query', () => {
    expect(executeAssistantTool(db(), sqlite, 'search_records', { q: '' }).ok).toBe(false)
  })
})

describe('get_week_tasks', () => {
  function addTask(date: string, title: string, checked = 0): void {
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, checked, created_at) VALUES ('daily', ?, ?, ?, 0)"
      )
      .run(date, title, checked)
  }

  it('returns the range (default rolling week) with done state, date-ordered', () => {
    const now = new Date()
    const ymd = (offsetDays: number): string => {
      const d = new Date(now.getTime() + offsetDays * 86_400_000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    addTask(ymd(2), 'later this week')
    addTask(ymd(0), 'today done', 1)
    addTask(ymd(10), 'outside window')

    const res = executeAssistantTool(db(), sqlite, 'get_week_tasks', {})
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { tasks: Array<{ title: string; checked: number }> } })
      .data
    expect(data.tasks.map((t) => t.title)).toEqual(['today done', 'later this week'])
  })

  it('rejects bad dates, inverted ranges, and oversized ranges', () => {
    expect(executeAssistantTool(db(), sqlite, 'get_week_tasks', { from: 'nope' }).ok).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'get_week_tasks', { from: '2026-06-15', to: '2026-06-01' })
        .ok
    ).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'get_week_tasks', { from: '2026-01-01', to: '2026-12-31' })
        .ok
    ).toBe(false)
  })
})

describe('get_weekly_goals', () => {
  it('reads the Monday-keyed goals for the week containing the date', () => {
    // 2026-06-17 is a Wednesday; its week key is Monday 2026-06-15.
    sqlite
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('weekly_goals_2026-06-15', JSON.stringify(['Ship feature', '', 'Run 3x']))

    const res = executeAssistantTool(db(), sqlite, 'get_weekly_goals', { date: '2026-06-17' })
    expect(res).toEqual({
      ok: true,
      data: { weekStart: '2026-06-15', goals: ['Ship feature', 'Run 3x'] }
    })
  })

  it('returns empty goals when none stored, and rejects bad dates', () => {
    const res = executeAssistantTool(db(), sqlite, 'get_weekly_goals', { date: '2026-06-17' })
    expect(res).toMatchObject({ ok: true, data: { goals: [] } })
    expect(executeAssistantTool(db(), sqlite, 'get_weekly_goals', { date: 'someday' }).ok).toBe(
      false
    )
  })
})

describe('get_habit_streaks', () => {
  it('computes current (today-or-yesterday anchored) and longest streaks for active habits', () => {
    sqlite.prepare("INSERT INTO habits (name, active) VALUES ('Meditate', 1)").run()
    sqlite.prepare("INSERT INTO habits (name, active) VALUES ('Retired', 0)").run()
    const ymd = (offsetDays: number): string => {
      const d = new Date(Date.now() + offsetDays * 86_400_000)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    // Yesterday + day before checked; today not yet → current streak 2.
    for (const off of [-1, -2]) {
      sqlite
        .prepare('INSERT INTO habit_entries (habit_id, date, completed) VALUES (1, ?, 1)')
        .run(ymd(off))
    }

    const res = executeAssistantTool(db(), sqlite, 'get_habit_streaks', {})
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: Array<{ name: string; current: number }> }).data
    expect(data).toHaveLength(1) // inactive habit excluded
    expect(data[0]).toMatchObject({ name: 'Meditate', current: 2, longest: 2 })
  })
})

describe('get_insights', () => {
  it('surfaces the same detectors as the Dashboard card', () => {
    const m = today().slice(0, 7)
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, category) VALUES (?, ?, ?)')
      .run(`${m}-01`, -150, 'Uncategorized')

    const res = executeAssistantTool(db(), sqlite, 'get_insights', {})
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: Array<{ kind: string }> }).data
    expect(data.some((i) => i.kind === 'uncategorized-spend')).toBe(true)
  })
})

describe('get_upcoming', () => {
  it("returns today's tasks + windowed events + payments due", () => {
    sqlite
      .prepare(
        "INSERT INTO checklist_items (list_type, list_date, title, created_at) VALUES ('daily', ?, 'Ship 8.5', 0)"
      )
      .run(today())
    const soon = Date.now() + 2 * 86_400_000
    sqlite
      .prepare('INSERT INTO calendar_events (title, start_at) VALUES (?, ?)')
      .run('Standup', soon)
    sqlite
      .prepare('INSERT INTO calendar_events (title, start_at) VALUES (?, ?)')
      .run('Far away', Date.now() + 60 * 86_400_000)
    const due = new Date(Date.now() + 3 * 86_400_000)
    const dueStr = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
    sqlite
      .prepare(
        "INSERT INTO finance_accounts (name, balance, payment_due_date) VALUES ('Visa', -100, ?)"
      )
      .run(dueStr)

    const res = executeAssistantTool(db(), sqlite, 'get_upcoming', { days: 7 })
    expect(res.ok).toBe(true)
    const data = (
      res as {
        ok: true
        data: { tasks: unknown[]; events: Array<{ title: string }>; paymentsDue: unknown[] }
      }
    ).data
    expect(data.tasks).toHaveLength(1)
    expect(data.events.map((e) => e.title)).toEqual(['Standup']) // far-away event excluded
    expect(data.paymentsDue).toHaveLength(1)
  })
})

describe('get_finance_summary', () => {
  it('returns aggregates (net worth + monthly + by-category), never raw rows', () => {
    sqlite
      .prepare("INSERT INTO finance_accounts (name, balance, is_debt) VALUES ('Checking', 5000, 0)")
      .run()
    sqlite
      .prepare("INSERT INTO finance_accounts (name, balance, is_debt) VALUES ('Card', 1200, 1)")
      .run()
    const m = today().slice(0, 7)
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, category) VALUES (?, ?, ?)')
      .run(`${m}-05`, -80, 'Groceries')
    sqlite
      .prepare('INSERT INTO finance_transactions (date, amount, category) VALUES (?, ?, ?)')
      .run(`${m}-06`, 3000, 'Income')

    const res = executeAssistantTool(db(), sqlite, 'get_finance_summary', { months: 6 })
    expect(res.ok).toBe(true)
    const data = (
      res as {
        ok: true
        data: {
          netWorth: { net: number }
          currentMonth: { byCategory: Array<{ category: string; spent: number }> }
        }
      }
    ).data
    expect(data.netWorth.net).toBe(3800) // 5000 assets − 1200 liability
    expect(data.currentMonth.byCategory.find((c) => c.category === 'Groceries')?.spent).toBe(80)
    // No raw-transaction field is exposed.
    expect(JSON.stringify(data)).not.toContain('Income') // income isn't a spend category row
  })
})

describe('propose_task', () => {
  it('enqueues a pending proposal (does NOT add a checklist item)', () => {
    const res = executeAssistantTool(db(), sqlite, 'propose_task', {
      title: 'Call dentist',
      listType: 'daily'
    })
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: { proposalId: string } }).data
    expect(data.proposalId).toMatch(/^[0-9a-f-]{36}$/)

    const proposals = db().select().from(schema.claudeProposals).all()
    expect(proposals).toHaveLength(1)
    expect(proposals[0].status).toBe('pending')
    expect(proposals[0].source).toBe('ask-compass')
    expect(JSON.parse(proposals[0].payload).title).toBe('Call dentist')
    // It must NOT have written a real checklist item.
    expect(db().select().from(schema.checklistItems).all()).toHaveLength(0)
  })

  it('rejects an empty title, bad listType, and impossible date', () => {
    expect(executeAssistantTool(db(), sqlite, 'propose_task', {}).ok).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'propose_task', { title: 'x', listType: 'master' }).ok
    ).toBe(false)
    expect(
      executeAssistantTool(db(), sqlite, 'propose_task', { title: 'x', listDate: '2026-02-30' }).ok
    ).toBe(false)
    expect(db().select().from(schema.claudeProposals).all()).toHaveLength(0)
  })
})

describe('executeAssistantTool', () => {
  it('returns an error for an unknown tool', () => {
    const res = executeAssistantTool(db(), sqlite, 'nope', {})
    expect(res).toEqual({ ok: false, error: 'Unknown tool: nope' })
  })
})

// ── Full-detail tools (data-access policy) ───────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: terse access to the tagged tool result in assertions
const toolData = (res: unknown): any => (res as { data: unknown }).data

describe('list_transactions', () => {
  function addTxn(date: string, amount: number, description: string, category = 'Dining'): void {
    sqlite
      .prepare(
        'INSERT INTO finance_transactions (date, amount, description, category) VALUES (?,?,?,?)'
      )
      .run(date, amount, description, category)
  }

  it('returns individual rows newest-first (the old aggregates-only wall is gone)', () => {
    addTxn('2026-06-01', -6.5, 'STARBUCKS')
    addTxn('2026-06-15', -42, 'WHOLE FOODS', 'Groceries')
    const res = executeAssistantTool(db(), sqlite, 'list_transactions', {})
    expect(res.ok).toBe(true)
    expect(toolData(res).transactions.map((t: { description: string }) => t.description)).toEqual([
      'WHOLE FOODS',
      'STARBUCKS'
    ])
  })

  it('filters by month, category, and description substring', () => {
    addTxn('2026-06-01', -6.5, 'STARBUCKS')
    addTxn('2026-05-01', -9, 'STARBUCKS RESERVE')
    addTxn('2026-06-02', -42, 'WHOLE FOODS', 'Groceries')
    expect(
      toolData(executeAssistantTool(db(), sqlite, 'list_transactions', { month: '2026-06' })).count
    ).toBe(2)
    expect(
      toolData(executeAssistantTool(db(), sqlite, 'list_transactions', { q: 'starbucks' })).count
    ).toBe(2)
    expect(
      toolData(executeAssistantTool(db(), sqlite, 'list_transactions', { category: 'Groceries' }))
        .count
    ).toBe(1)
  })

  it('rejects malformed dates/months', () => {
    expect(executeAssistantTool(db(), sqlite, 'list_transactions', { month: 'June' }).ok).toBe(
      false
    )
    expect(executeAssistantTool(db(), sqlite, 'list_transactions', { from: 'nope' }).ok).toBe(false)
  })
})

describe('search_contacts / get_contact', () => {
  beforeEach(() => {
    sqlite
      .prepare(
        `INSERT INTO contacts (external_id, display_name, org, job_title, relationship, search_blob, phones, emails, photo, enrichment)
         VALUES ('c1', 'Jane Doe', 'Acme', 'CTO', 'colleague', 'jane doe acme jane@example.com',
                 '[{"type":"cell","value":"+1 555 0100"}]', '[{"type":"home","value":"jane@example.com"}]',
                 'data:image/png;base64,xxxx', '{"crossSource":{"sources":["gmail","linkedin"]}}')`
      )
      .run()
  })

  it('search finds contacts by blob and returns the light list shape', () => {
    const res = executeAssistantTool(db(), sqlite, 'search_contacts', { q: 'jane' })
    expect(res.ok).toBe(true)
    expect(toolData(res).contacts[0]).toEqual({
      id: 1,
      displayName: 'Jane Doe',
      org: 'Acme',
      jobTitle: 'CTO',
      relationship: 'colleague'
    })
  })

  it('get_contact returns the full card with parsed arrays + crossSource, never the photo', () => {
    const res = executeAssistantTool(db(), sqlite, 'get_contact', { id: 1 })
    expect(res.ok).toBe(true)
    const card = toolData(res)
    expect(card.emails).toEqual([{ type: 'home', value: 'jane@example.com' }])
    expect(card.phones).toEqual([{ type: 'cell', value: '+1 555 0100' }])
    expect(card.crossSource).toEqual({ sources: ['gmail', 'linkedin'] })
    expect(JSON.stringify(card)).not.toContain('base64')
  })

  it('rejects a missing query / unknown id', () => {
    expect(executeAssistantTool(db(), sqlite, 'search_contacts', {}).ok).toBe(false)
    expect(executeAssistantTool(db(), sqlite, 'get_contact', { id: 99 }).ok).toBe(false)
  })
})

describe('get_medical_records', () => {
  beforeEach(() => {
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, code, status, recorded_at) VALUES ('m1', 'medication', 'Aspirin 81mg', 'RxNorm:243670', 'active', '2026-03-10')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO medical_records (external_id, category, description, status) VALUES ('m2', 'condition', 'Migraine', 'resolved')"
      )
      .run()
  })

  it('returns FULL clinical rows (the counts-only wall is gone)', () => {
    const res = executeAssistantTool(db(), sqlite, 'get_medical_records', {})
    expect(res.ok).toBe(true)
    expect(toolData(res).count).toBe(2)
    expect(toolData(res).records[0]).toMatchObject({
      category: 'medication',
      description: 'Aspirin 81mg',
      code: 'RxNorm:243670',
      status: 'active',
      recordedAt: '2026-03-10'
    })
  })

  it('filters by category/status and rejects an unknown category', () => {
    expect(
      toolData(executeAssistantTool(db(), sqlite, 'get_medical_records', { category: 'condition' }))
        .count
    ).toBe(1)
    expect(
      toolData(executeAssistantTool(db(), sqlite, 'get_medical_records', { status: 'ACTIVE' }))
        .count
    ).toBe(1)
    expect(
      executeAssistantTool(db(), sqlite, 'get_medical_records', { category: 'surgery' }).ok
    ).toBe(false)
  })
})

describe('get_paystubs', () => {
  it('returns per-stub rows newest-first plus totals', () => {
    sqlite
      .prepare(
        "INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, paid_at) VALUES ('p1', 'Initech', 4000, 3000, '2026-06-16')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO argyle_paystubs (external_id, employer, gross_pay, net_pay, paid_at) VALUES ('p2', 'Initech', 4000, 3010, '2026-06-30')"
      )
      .run()
    const res = executeAssistantTool(db(), sqlite, 'get_paystubs', {})
    expect(res.ok).toBe(true)
    expect(toolData(res).paystubs.map((p: { netPay: number }) => p.netPay)).toEqual([3010, 3000])
    expect(toolData(res).totals).toMatchObject({ count: 2, totalNet: 6010, totalGross: 8000 })
  })
})

describe('search_vault / get_vault_entry (docs open, credentials sealed)', () => {
  const fakeVault = {
    calls: [] as string[],
    readCategory(category: string): Array<Record<string, unknown>> {
      fakeVault.calls.push(category)
      if (category === 'identity') {
        return [
          {
            id: 'e1',
            documentType: 'Passport',
            name: 'Chris',
            passportNumber: 'X1234567',
            _history: [{ passportNumber: 'OLD' }]
          }
        ]
      }
      return []
    }
  }
  beforeEach(() => {
    fakeVault.calls = []
  })

  it('search_vault finds document entries by any field value', () => {
    const res = executeAssistantTool(
      db(),
      sqlite,
      'search_vault',
      { q: 'x1234567' },
      { vault: fakeVault }
    )
    expect(res.ok).toBe(true)
    expect(toolData(res).entries[0]).toMatchObject({
      category: 'identity',
      id: 'e1',
      matchedField: 'passportNumber'
    })
  })

  it('get_vault_entry returns the full entry minus _history', () => {
    const res = executeAssistantTool(
      db(),
      sqlite,
      'get_vault_entry',
      { category: 'identity', id: 'e1' },
      { vault: fakeVault }
    )
    expect(res.ok).toBe(true)
    expect(toolData(res).entry).toEqual({
      id: 'e1',
      documentType: 'Passport',
      name: 'Chris',
      passportNumber: 'X1234567'
    })
    expect('_history' in toolData(res).entry).toBe(false)
  })

  it('REFUSES the credentials category with an explanatory error, never touching the reader', () => {
    for (const [tool, input] of [
      ['search_vault', { q: 'netflix', category: 'credentials' }],
      ['get_vault_entry', { category: 'credentials', id: 'c1' }]
    ] as const) {
      const res = executeAssistantTool(db(), sqlite, tool, input, { vault: fakeVault })
      expect(res.ok).toBe(false)
      expect(!res.ok && res.error).toContain('sealed')
    }
    // The reader was never asked for credentials — the gate is at the tool boundary.
    expect(fakeVault.calls).not.toContain('credentials')
  })

  it('a full-vault search never queries the credentials category', () => {
    executeAssistantTool(db(), sqlite, 'search_vault', { q: 'anything' }, { vault: fakeVault })
    expect(fakeVault.calls).toEqual([
      'financial',
      'identity',
      'medical',
      'legal',
      'foreign-accounts'
    ])
  })

  it('fails cleanly when no vault reader is wired (tests, non-production contexts)', () => {
    const res = executeAssistantTool(db(), sqlite, 'search_vault', { q: 'x' })
    expect(res).toEqual({ ok: false, error: 'Vault unavailable in this context.' })
  })

  it('rejects an unknown category', () => {
    const res = executeAssistantTool(
      db(),
      sqlite,
      'search_vault',
      { q: 'x', category: 'attic' },
      { vault: fakeVault }
    )
    expect(res.ok).toBe(false)
  })
})

describe('get_timeline', () => {
  beforeEach(() => {
    sqlite.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, type TEXT NOT NULL,
        occurred_at INTEGER, title TEXT
      );
    `)
  })

  it('summarizes by source, kind, and year — aggregates only, no titles', () => {
    const ins = sqlite.prepare(
      'INSERT INTO records (source, type, occurred_at, title) VALUES (?, ?, ?, ?)'
    )
    ins.run('paypal', 'payment', Date.UTC(2019, 5, 15), 'Coffee — 4.50 USD')
    ins.run('venmo', 'payment', Date.UTC(2019, 8, 1), 'Split dinner')
    ins.run('netflix', 'watch', Date.UTC(2022, 0, 3), 'Some Show')
    ins.run('amazon', 'order', null, 'Undated order') // no date → excluded from span/byYear

    const res = executeAssistantTool(db(), sqlite, 'get_timeline', {})
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.error)
    const data = res.data as {
      total: number
      sources: Array<{ source: string; count: number }>
      kinds: Array<{ kind: string; count: number }>
      span: { earliestYear: number; latestYear: number } | null
      byYear: Array<{ year: number; count: number }>
    }
    expect(data.total).toBe(4)
    expect(data.kinds.find((k) => k.kind === 'payment')?.count).toBe(2)
    expect(data.sources.find((s) => s.source === 'paypal')?.count).toBe(1)
    expect(data.span).toEqual({ earliestYear: 2019, latestYear: 2022 })
    expect(data.byYear).toEqual([
      { year: 2019, count: 2 },
      { year: 2022, count: 1 }
    ]) // undated row excluded
    // The invariant: aggregates only — no raw record titles leak to the model.
    expect(JSON.stringify(data)).not.toContain('Coffee')
  })

  it('handles an empty timeline gracefully', () => {
    const res = executeAssistantTool(db(), sqlite, 'get_timeline', {})
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.error)
    expect((res.data as { total: number }).total).toBe(0)
  })
})
