/**
 * One-shot import from the legacy Excel ledger pipeline into the Compass DB.
 *
 * Reads JSON dumps that the Python side produces (exceljs trips on the
 * structured-table metadata in master_ledger.xlsx; openpyxl on the Python
 * side handles it cleanly, so we go through it):
 *
 *   ~/Documents/Claude/Projects/Getting on top of finances/03_ledger/master_ledger.compass.json
 *   ~/Documents/Claude/Projects/Getting on top of finances/05_debt_tracker/debt_tracker.compass.json
 *   ~/Documents/Claude/Projects/Getting on top of finances/07_categories/categories.json
 *
 * Run:
 *   # In the legacy project, dump the xlsx to JSON:
 *   cd ~/Documents/Claude/Projects/'Getting on top of finances' && python3 08_scripts/dump_for_compass.py
 *
 *   # Then in compass:
 *   npx tsx scripts/import-from-excel.ts
 *
 * Idempotent — re-running is safe. Existing rows are matched by hash
 * (transactions), pattern (rules), or name (accounts/debts). Unchanged rows
 * are skipped; new rows are inserted.
 *
 * Override the source dir with FINANCE_PROJECT_DIR env var.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { getDb, initDb } from '../electron/db/client'
import { categorizationRules, financeAccounts, financeTransactions } from '../electron/db/schema'
import { tagGeoAndPurpose } from '../electron/integrations/finance-geo'

const PROJECT_DIR =
  process.env.FINANCE_PROJECT_DIR ??
  join(homedir(), 'Documents', 'Claude', 'Projects', 'Getting on top of finances')
const LEDGER_JSON = join(PROJECT_DIR, '03_ledger', 'master_ledger.compass.json')
const RULES_JSON = join(PROJECT_DIR, '07_categories', 'categories.json')
const DEBT_JSON = join(PROJECT_DIR, '05_debt_tracker', 'debt_tracker.compass.json')

type LedgerRow = {
  date: string
  amount: number
  description: string
  account: string
  category: string
  subcategory: string | null
  notes: string | null
  sourceFile: string | null
  hash: string
}

type DebtRow = { name: string; balance: number; apr: number; minPayment: number }

type RuleJson = { _version?: number; rules: Record<string, [string, string]> }

function readLedger(): LedgerRow[] {
  if (!existsSync(LEDGER_JSON)) {
    throw new Error(
      `Ledger JSON not found at ${LEDGER_JSON}. Run \`python3 08_scripts/dump_for_compass.py\` in the legacy project first.`
    )
  }
  return JSON.parse(readFileSync(LEDGER_JSON, 'utf8')) as LedgerRow[]
}

function readDebts(): DebtRow[] {
  if (!existsSync(DEBT_JSON)) return []
  return JSON.parse(readFileSync(DEBT_JSON, 'utf8')) as DebtRow[]
}

function readRules(): { pattern: string; category: string; subcategory: string | null }[] {
  if (!existsSync(RULES_JSON)) return []
  const data = JSON.parse(readFileSync(RULES_JSON, 'utf8')) as RuleJson
  return Object.entries(data.rules ?? {}).map(([pattern, [category, subcategory]]) => ({
    pattern,
    category,
    subcategory: subcategory || null
  }))
}

function inferAccountType(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('savings')) return 'savings'
  if (
    n.includes('amex') ||
    n.includes('hilton') ||
    n.includes('platinum') ||
    n.includes('credit')
  ) {
    return 'credit_card'
  }
  if (n.includes('paypal')) return 'cash'
  if (n.includes('checking')) return 'checking'
  return 'checking'
}

function inferInstitution(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('amex') || n.includes('hilton') || n.includes('platinum')) {
    return 'American Express'
  }
  if (n.includes('usaa')) return 'USAA'
  if (n.includes('paypal')) return 'PayPal'
  return ''
}

async function main(): Promise<void> {
  console.log(`Importing from ${PROJECT_DIR}`)

  await initDb()
  const db = getDb()

  // ── Accounts ──────────────────────────────────────────────────────────────
  console.log('Reading ledger…')
  const ledger = readLedger()
  console.log(`  ${ledger.length.toLocaleString()} transactions parsed`)
  const accountNames = Array.from(new Set(ledger.map((r) => r.account))).filter(Boolean)
  console.log(`  ${accountNames.length} unique accounts`)

  const existingAccounts = db.select().from(financeAccounts).all()
  const existingByName = new Map(existingAccounts.map((a) => [a.name, a]))
  let createdAccts = 0
  for (const name of accountNames) {
    if (existingByName.has(name)) continue
    db.insert(financeAccounts)
      .values({ name, type: inferAccountType(name), institution: inferInstitution(name) })
      .run()
    createdAccts++
  }
  console.log(`  + ${createdAccts} accounts created`)

  const accountIdByName = new Map(
    db
      .select({ id: financeAccounts.id, name: financeAccounts.name })
      .from(financeAccounts)
      .all()
      .map((a) => [a.name, a.id])
  )

  // ── Rules ─────────────────────────────────────────────────────────────────
  console.log('Reading rules…')
  const rules = readRules()
  console.log(`  ${rules.length} rules in categories.json`)
  const existingRules = new Set(
    db
      .select({ pattern: categorizationRules.pattern })
      .from(categorizationRules)
      .all()
      .map((r) => r.pattern)
  )
  let createdRules = 0
  for (const r of rules) {
    if (existingRules.has(r.pattern)) continue
    db.insert(categorizationRules)
      .values({
        pattern: r.pattern,
        category: r.category,
        subcategory: r.subcategory ?? undefined,
        priority: 100
      })
      .onConflictDoNothing()
      .run()
    createdRules++
  }
  console.log(`  + ${createdRules} rules inserted`)

  // ── Transactions ──────────────────────────────────────────────────────────
  console.log('Inserting transactions…')
  const existingHashes = new Set(
    db
      .select({ h: financeTransactions.hash })
      .from(financeTransactions)
      .all()
      .map((r) => r.h)
  )
  // Re-tag geo+purpose at import time so existing rows are consistent with
  // what new ingests will produce going forward (idempotent).
  const tagged = tagGeoAndPurpose(
    ledger.map((r) => ({
      date: r.date,
      amount: r.amount,
      description: r.description,
      account: r.account,
      category: r.category,
      subcategory: r.subcategory ?? undefined,
      notes: r.notes ?? undefined,
      sourceFile: r.sourceFile ?? '',
      hash: r.hash
    }))
  )
  let inserted = 0
  for (const t of tagged) {
    if (existingHashes.has(t.hash)) continue
    db.insert(financeTransactions)
      .values({
        hash: t.hash,
        date: t.date,
        amount: t.amount,
        description: t.description,
        accountId: accountIdByName.get(t.account) ?? null,
        category: t.category ?? 'Uncategorized',
        subcategory: t.subcategory,
        notes: t.notes,
        sourceFile: t.sourceFile,
        ingestedAt: new Date()
      })
      .onConflictDoNothing()
      .run()
    inserted++
  }
  console.log(
    `  + ${inserted.toLocaleString()} transactions inserted (${(ledger.length - inserted).toLocaleString()} already present)`
  )

  // ── Debts ─────────────────────────────────────────────────────────────────
  // Compass models debts as financeAccounts rows with isDebt=true (no separate
  // financeDebts table). Existing accounts that match by name get debt fields
  // back-filled; otherwise a new debt-flavored account row is created.
  console.log('Reading debt tracker…')
  const debts = readDebts()
  let createdDebts = 0
  let updatedDebts = 0
  for (const d of debts) {
    const existing = db.select().from(financeAccounts).where(eq(financeAccounts.name, d.name)).get()
    if (existing) {
      db.update(financeAccounts)
        .set({
          isDebt: true,
          balance: d.balance,
          apr: d.apr,
          minPayment: d.minPayment,
          updatedAt: new Date()
        })
        .where(eq(financeAccounts.id, existing.id))
        .run()
      updatedDebts++
    } else {
      db.insert(financeAccounts)
        .values({
          name: d.name,
          type: 'credit',
          isDebt: true,
          balance: d.balance,
          apr: d.apr,
          minPayment: d.minPayment,
          institution: inferInstitution(d.name)
        })
        .run()
      createdDebts++
    }
  }
  console.log(
    `  + ${createdDebts} debt accounts created, ${updatedDebts} existing accounts back-filled with debt fields`
  )

  console.log('\nImport complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
