#!/usr/bin/env tsx
/**
 * Seed synthetic demo data for README screenshots.
 *
 * SAFETY: this writes a full Compass data store (DB + knowledge files +
 * app settings) with DESTRUCTIVE inserts/updates. It must NEVER touch a real
 * user's data, so it refuses to run unless BOTH COMPASS_SEED_DEMO=1 is set
 * AND COMPASS_HOME points at an isolated throwaway dir (≠ the real home).
 * All data here is fabricated — no real names, accounts, tokens, or secrets.
 *
 * Run (from repo root):
 *   COMPASS_SEED_DEMO=1 COMPASS_HOME="$(mktemp -d)" npx tsx scripts/seed-demo.ts
 *
 * paths.ts honors COMPASS_HOME (opt-in) to redirect the entire store.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getRawSqlite, initDb } from '../electron/db/client'
import { seedKnowledgeFiles, updateKnowledgeFile } from '../electron/knowledge/writer'
import { APP_DATA_DIR, DATA_DIR, KNOWLEDGE_DIR, VAULT_DIR } from '../electron/paths'

// Hard safety gate. This script performs DESTRUCTIVE inserts/updates, so it
// must never run against a real store. Two independent conditions:
//   1. explicit opt-in via COMPASS_SEED_DEMO=1, and
//   2. the data root must be ISOLATED — COMPASS_HOME set to something other
//      than the real OS home (paths.ts otherwise falls back to homedir()).
// Without (2), `tsx scripts/seed-demo.ts` would overwrite ~/Library/.../Compass.
const compassHome = process.env.COMPASS_HOME?.trim() ?? ''
const isIsolated = compassHome.length > 0 && compassHome !== homedir()
if (process.env.COMPASS_SEED_DEMO !== '1' || !isIsolated) {
  console.error(
    `Refusing to run: this seeder is destructive. Require BOTH:
  COMPASS_SEED_DEMO=1   (explicit opt-in)
  COMPASS_HOME=<throwaway dir>   (isolated store, must differ from your real home)
Resolved data dir would have been: ${APP_DATA_DIR}`
  )
  process.exit(1)
}

const iso = (d: Date): string => d.toISOString().slice(0, 10)
const hashTxn = (date: string, amount: number, desc: string, account: string): string =>
  createHash('sha1')
    .update(`${date}|${amount.toFixed(2)}|${desc.trim().toLowerCase()}|${account}`)
    .digest('hex')
    .slice(0, 16)

async function main(): Promise<void> {
  // paths.ts mkdir is the app's job (main.ts); replicate for a standalone seed.
  for (const d of [
    DATA_DIR,
    VAULT_DIR,
    KNOWLEDGE_DIR,
    join(KNOWLEDGE_DIR, 'profile'),
    join(KNOWLEDGE_DIR, 'work'),
    join(KNOWLEDGE_DIR, 'calendar'),
    join(KNOWLEDGE_DIR, 'inbox'),
    join(KNOWLEDGE_DIR, 'drive'),
    join(KNOWLEDGE_DIR, 'templates')
  ]) {
    mkdirSync(d, { recursive: true })
  }

  await initDb()
  const db = getRawSqlite()
  const now = new Date()
  const nowMs = now.getTime()
  const DAY = 86_400_000

  // ── App settings: skip onboarding, dark theme ────────────────────────────
  const setSetting = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  setSetting.run('onboardingCompleted', 'true')
  setSetting.run('theme', 'dark')
  // NB: intentionally do NOT set financeWatchFolder — pointing it at a
  // non-existent demo path makes the Finance page show a "folder doesn't
  // exist" warning banner in screenshots.

  // ── Finance accounts ─────────────────────────────────────────────────────
  const insAcct = db.prepare(
    `INSERT INTO finance_accounts (name, type, is_debt, balance, apr, min_payment, credit_limit, institution, asset_class, payment_day_of_month, updated_at)
     VALUES (@name, @type, @isDebt, @balance, @apr, @minPayment, @creditLimit, @institution, @assetClass, @payDay, @updatedAt)`
  )
  const accounts: Array<{
    name: string
    type: string
    isDebt: number
    balance: number
    apr: number
    minPayment: number
    creditLimit: number | null
    institution: string
    assetClass: string
    payDay: number | null
  }> = [
    {
      name: 'Everyday Checking',
      type: 'checking',
      isDebt: 0,
      balance: 4280.55,
      apr: 0,
      minPayment: 0,
      creditLimit: null,
      institution: 'Mercury',
      assetClass: 'spending',
      payDay: null
    },
    {
      name: 'High-Yield Savings',
      type: 'savings',
      isDebt: 0,
      balance: 21850.0,
      apr: 0,
      minPayment: 0,
      creditLimit: null,
      institution: 'Ally',
      assetClass: 'savings',
      payDay: null
    },
    {
      name: 'Brokerage',
      type: 'investment',
      isDebt: 0,
      balance: 92400.0,
      apr: 0,
      minPayment: 0,
      creditLimit: null,
      institution: 'Fidelity',
      assetClass: 'retirement',
      payDay: null
    },
    {
      name: 'Sapphire Card',
      type: 'credit',
      isDebt: 1,
      balance: 2410.18,
      apr: 0.2249,
      minPayment: 75,
      creditLimit: 15000,
      institution: 'Chase',
      assetClass: 'liability',
      payDay: 15
    },
    {
      name: 'Primary Residence',
      type: 'investment',
      isDebt: 0,
      balance: 540000,
      apr: 0,
      minPayment: 0,
      creditLimit: null,
      institution: 'Manual',
      assetClass: 'real_estate',
      payDay: null
    },
    {
      name: 'Mortgage',
      type: 'credit',
      isDebt: 1,
      balance: 318500,
      apr: 0.0625,
      minPayment: 2180,
      creditLimit: null,
      institution: 'Rocket',
      assetClass: 'liability',
      payDay: 1
    }
  ]
  const acctIds: Record<string, number> = {}
  for (const a of accounts) {
    const info = insAcct.run({ ...a, updatedAt: nowMs })
    acctIds[a.name] = Number(info.lastInsertRowid)
  }

  // ── Transactions: ~12 months of recurring + variable activity ────────────
  const insTxn = db.prepare(
    `INSERT OR IGNORE INTO finance_transactions (hash, date, amount, description, account_id, category, subcategory, geo, tax_tag, tax_tag_source, tax_year, source_file, ingested_at)
     VALUES (@hash, @date, @amount, @description, @accountId, @category, @subcategory, 'US', 'tax:none', 'auto', @taxYear, 'demo', @ingestedAt)`
  )
  const checking = acctIds['Everyday Checking']
  const card = acctIds['Sapphire Card']
  const addTxn = (
    date: string,
    amount: number,
    description: string,
    category: string,
    accountId: number
  ): void => {
    insTxn.run({
      hash: hashTxn(date, amount, description, String(accountId)),
      date,
      amount,
      description,
      accountId,
      category,
      subcategory: null,
      taxYear: Number(date.slice(0, 4)),
      ingestedAt: nowMs
    })
  }
  // 12 monthly cycles ending this month.
  for (let mAgo = 11; mAgo >= 0; mAgo--) {
    const base = new Date(now.getFullYear(), now.getMonth() - mAgo, 1)
    const y = base.getFullYear()
    const m = base.getMonth()
    const d = (day: number): string => iso(new Date(y, m, day))
    // Income
    addTxn(d(1), 6500, 'Acme Corp Payroll', 'Income', checking)
    addTxn(d(16), 1200, 'Freelance — Design Retainer', 'Income', checking)
    // Housing / fixed
    addTxn(d(1), -2180, 'Mortgage Payment', 'Housing', checking)
    addTxn(d(5), -180, 'City Utilities', 'Utilities', checking)
    addTxn(d(5), -95, 'Fiber Internet', 'Utilities', checking)
    // Subscriptions (recur → CR&Subs + a price-hike on streaming)
    addTxn(d(8), -(mAgo < 3 ? 22.99 : 15.49), 'Netflix', 'Subscriptions', card)
    addTxn(d(8), -11.99, 'Spotify', 'Subscriptions', card)
    addTxn(d(12), -20, 'iCloud+', 'Subscriptions', card)
    addTxn(d(20), -52, 'Gym Membership', 'Health', card)
    // Variable spend
    addTxn(d(3), -(320 + (mAgo % 4) * 18), 'Whole Foods', 'Groceries', card)
    addTxn(d(11), -(210 + (mAgo % 3) * 25), 'Trader Joe’s', 'Groceries', card)
    addTxn(d(14), -(88 + (mAgo % 5) * 12), 'Dinner — Local Bistro', 'Dining', card)
    addTxn(d(22), -64, 'Uber', 'Transport', card)
    addTxn(d(25), -(140 + (mAgo % 6) * 20), 'Amazon', 'Shopping', card)
    // Credit card payment
    addTxn(d(15), -650, 'Payment — Sapphire Card', 'Transfers', checking)
  }

  // ── Net-worth balance snapshots (monthly trajectory) ─────────────────────
  const insSnap = db.prepare(
    'INSERT INTO finance_balance_snapshots (account_id, captured_at, balance, source) VALUES (?, ?, ?, ?)'
  )
  const trajectory: Array<[string, number, number]> = [
    // [account, startBalance 12mo ago, monthlyDelta]
    ['High-Yield Savings', 14500, 612],
    ['Brokerage', 71000, 1783],
    ['Primary Residence', 528000, 1000],
    ['Mortgage', 330200, -978]
  ]
  for (const [name, start, delta] of trajectory) {
    const id = acctIds[name]
    for (let mAgo = 12; mAgo >= 0; mAgo--) {
      const capturedAt = nowMs - mAgo * 30 * DAY
      insSnap.run(id, capturedAt, start + (12 - mAgo) * delta, 'inferred')
    }
  }

  // ── Budget rules (for the Budget view) ───────────────────────────────────
  const insBudget = db.prepare(
    'INSERT INTO budget_rules (category, subcategory, monthly_amount, updated_at) VALUES (?, ?, ?, ?)'
  )
  for (const [cat, amt] of [
    ['Groceries', 650],
    ['Dining', 300],
    ['Subscriptions', 60],
    ['Shopping', 250],
    ['Transport', 150],
    ['Utilities', 300]
  ] as Array<[string, number]>) {
    insBudget.run(cat, null, amt, nowMs)
  }

  // ── Habits + entries (streaks) ───────────────────────────────────────────
  const insHabit = db.prepare(
    'INSERT INTO habits (name, icon, color, active, created_at) VALUES (?, ?, ?, 1, ?)'
  )
  const insEntry = db.prepare(
    'INSERT INTO habit_entries (habit_id, date, completed) VALUES (?, ?, 1)'
  )
  const habitSpec: Array<[string, string, number]> = [
    // [name, color, currentStreakDays]
    ['Exercise', '#6272f1', 9],
    ['Read 20 min', '#22c55e', 14],
    ['Meditate', '#f59e0b', 4],
    ['Journal', '#ec4899', 21]
  ]
  for (const [name, color, streak] of habitSpec) {
    const id = Number(insHabit.run(name, '✶', color, nowMs).lastInsertRowid)
    for (let i = 0; i < streak; i++) insEntry.run(id, iso(new Date(nowMs - i * DAY)))
  }

  // ── Checklist items (today + this week + this month) ─────────────────────
  const insCheck = db.prepare(
    `INSERT INTO checklist_items (list_type, list_date, title, body, checked, status, category, sort_order, source, created_at)
     VALUES (@listType, @listDate, @title, @body, @checked, @status, @category, @sortOrder, @source, @createdAt)`
  )
  const today = iso(now)
  const checkRows: Array<[string, string, string, number, string, string]> = [
    ['daily', today, 'Morning workout', 1, 'done', 'morning'],
    ['daily', today, 'Review calendar + inbox', 1, 'done', 'morning'],
    ['daily', today, 'Ship README draft', 0, 'in_progress', 'work'],
    ['daily', today, 'Reply to investor email', 0, 'unchecked', 'work'],
    ['daily', today, 'Pay Sapphire Card', 0, 'unchecked', 'personal'],
    ['daily', today, 'Read before bed', 0, 'unchecked', 'evening'],
    ['weekly', today, 'Weekly finance review', 0, 'unchecked', 'personal'],
    ['weekly', today, 'Plan next week priorities', 0, 'unchecked', 'work'],
    ['monthly', today, 'Reconcile budget vs actuals', 0, 'unchecked', 'personal']
  ]
  checkRows.forEach(([listType, listDate, title, checked, status, category], i) => {
    insCheck.run({
      listType,
      listDate,
      title,
      body: null,
      checked,
      status,
      category,
      sortOrder: i,
      source: 'manual',
      createdAt: nowMs
    })
  })

  // ── Calendar events (this week) ──────────────────────────────────────────
  const insEvent = db.prepare(
    `INSERT OR IGNORE INTO calendar_events (source, external_id, title, start_at, end_at, all_day, location, synced_at)
     VALUES ('google', @extId, @title, @startAt, @endAt, 0, @location, @syncedAt)`
  )
  const eventSpec: Array<[string, number, number, string]> = [
    ['Standup', 1, 9, 'Zoom'],
    ['1:1 with Sam', 1, 14, 'Office'],
    ['Design review', 2, 11, 'Figma'],
    ['Dentist', 3, 16, 'Downtown'],
    ['Investor call', 4, 10, 'Zoom']
  ]
  eventSpec.forEach(([title, dayOffset, hour, location], i) => {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0)
    insEvent.run({
      extId: `demo-evt-${i}`,
      title,
      startAt: start.getTime(),
      endAt: start.getTime() + 45 * 60_000,
      location,
      syncedAt: nowMs
    })
  })

  // ── GitHub items + Gmail actions (for Dashboard widgets) ─────────────────
  const insGh = db.prepare(
    `INSERT OR IGNORE INTO github_items (type, repo, external_id, title, url, state, labels, synced_at)
     VALUES (@type, @repo, @extId, @title, @url, 'open', @labels, @syncedAt)`
  )
  ;[
    ['issue', 'acme/app', 'Flaky test in checkout flow', '["bug"]'],
    ['pr', 'acme/app', 'feat: add CSV export', '["feature"]'],
    ['issue', 'acme/web', 'Polish empty states', '["design"]']
  ].forEach(([type, repo, title, labels], i) => {
    insGh.run({
      type,
      repo,
      extId: `demo-gh-${i}`,
      title,
      url: `https://github.com/${repo}/issues/${100 + i}`,
      labels,
      syncedAt: nowMs
    })
  })

  const insGmail = db.prepare(
    `INSERT OR IGNORE INTO gmail_actions (thread_id, subject, from_address, action_summary, snippet, received_at, done)
     VALUES (@threadId, @subject, @from, @summary, @snippet, @receivedAt, 0)`
  )
  ;[
    ['Q3 board deck — please review', 'sam@acme.co', 'Review + comment by Friday'],
    ['Invoice #2041 due', 'billing@vendor.com', 'Pay $1,250 by month end']
  ].forEach(([subject, from, summary], i) => {
    insGmail.run({
      threadId: `demo-mail-${i}`,
      subject,
      from,
      summary,
      snippet: summary,
      receivedAt: nowMs - i * DAY
    })
  })

  // ── Knowledge base: starter files + linked demo notes ────────────────────
  seedKnowledgeFiles(KNOWLEDGE_DIR)
  updateKnowledgeFile(
    KNOWLEDGE_DIR,
    'profile/personal.md',
    `# Personal Profile\n\n> Auto-updated by Compass — editable any time.\n\n## Basics\n- **Name:** Demo User\n- **Location:** Remote\n\n## Notes\nSee [[work/projects]] for what I'm building and [[profile/goals]] for the year.\n`
  )
  updateKnowledgeFile(
    KNOWLEDGE_DIR,
    'work/projects.md',
    `# Projects\n\n## Compass\nA local-first life OS. Daily driver for money, notes, and tasks.\n\n## Links\n- Owner profile: [[profile/personal]]\n- This quarter's goals: [[profile/goals]]\n`
  )
  updateKnowledgeFile(
    KNOWLEDGE_DIR,
    'profile/goals.md',
    '# Goals\n\n- [ ] Ship Compass 1.0\n- [ ] Hit 6-month emergency fund\n- [ ] Read 24 books\n\nBacklinks: referenced by [[profile/personal]] and [[work/projects]].\n'
  )

  console.log(`✓ Demo data seeded into ${DATA_DIR}`)
  console.log(
    `  accounts: ${accounts.length} · habits: ${habitSpec.length} · 12 months of transactions`
  )
}

main().catch((err) => {
  console.error('seed-demo failed:', err)
  process.exit(1)
})
