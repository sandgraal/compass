/**
 * Finance IPC handlers — exposed to the renderer via the preload bridge.
 *
 * After merging schema.finance.ts into electron/db/schema.ts:
 *   1. Uncomment the schema import below.
 *   2. Uncomment each handler's body.
 *   3. In electron/main.ts, add: registerFinanceHandlers(ipcMain).
 *   4. Add typed wrappers in electron/preload.ts and src/types/electron.d.ts.
 */

import { IpcMain } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
// import { eq, and, gte, lt, desc } from 'drizzle-orm'
// import { getDb } from '../db/client'
// import { financeAccounts, financeTransactions, financeDebts, financeBudgetLines, financeCategoryRules, financeSettings } from '../db/schema'
import { ingestCsvFolder, categorize, RawTxn } from '../integrations/finance'
import { writeAllFinanceKnowledge, FinanceSnapshot } from '../knowledge/finance-extractor'

// Default location user drops CSVs into. Configurable via finance_settings.
const DEFAULT_INBOX = join(homedir(), 'Documents', 'Compass', 'finance', 'inbox')

export function registerFinanceHandlers(ipcMain: IpcMain): void {
  // --- Ingest a folder of bank CSVs ---
  ipcMain.handle('finance:ingest-folder', async (_event, folder?: string) => {
    const inbox = folder || DEFAULT_INBOX
    if (!existsSync(inbox)) return { error: `Inbox folder not found: ${inbox}` }
    // const db = getDb()
    // const rules = db.select().from(financeCategoryRules).orderBy(financeCategoryRules.priority).all()
    const rules: any[] = []
    const result = await ingestCsvFolder(/* db */ null as any, inbox, undefined, undefined)
    // After ingest, refresh the markdown:
    // await refreshFinanceKnowledge(db)
    return result
  })

  // --- Read transactions (paginated, optionally filtered by month/category) ---
  ipcMain.handle('finance:get-transactions', (_event, opts?: { month?: string; category?: string; limit?: number }) => {
    // const db = getDb()
    // let q = db.select().from(financeTransactions).orderBy(desc(financeTransactions.date))
    // if (opts?.month) q = q.where(and(gte(financeTransactions.date, `${opts.month}-01`), lt(financeTransactions.date, nextMonth(opts.month))))
    // if (opts?.category) q = q.where(eq(financeTransactions.category, opts.category))
    // return q.limit(opts?.limit ?? 200).all()
    return []
  })

  // --- Debt summary (current state + avalanche projection) ---
  ipcMain.handle('finance:get-debt-summary', () => {
    // const db = getDb()
    // const debts = db.select().from(financeDebts).where(eq(financeDebts.active, true)).all()
    // const projection = simulateAvalanche(debts, monthlyDebtTarget(db))
    // return { debts, projection }
    return { debts: [], projection: [] }
  })

  // --- Budget status (this month) ---
  ipcMain.handle('finance:get-budget-status', (_event, month?: string) => {
    // const db = getDb()
    // const m = month ?? new Date().toISOString().slice(0, 7)
    // const budget = db.select().from(financeBudgetLines).all()
    // const txns = db.select().from(financeTransactions)
    //   .where(and(gte(financeTransactions.date, `${m}-01`), lt(financeTransactions.date, nextMonth(m))))
    //   .all()
    // return computeBudgetStatus(budget, txns)
    return { lines: [], totals: { budgeted: 0, actual: 0, variance: 0 } }
  })

  // --- Set / replace a budget line ---
  ipcMain.handle('finance:set-budget', (_event, line: { category: string; subcategory?: string; monthlyAmount: number }) => {
    // const db = getDb()
    // db.insert(financeBudgetLines).values({
    //   category: line.category, subcategory: line.subcategory, monthlyAmount: line.monthlyAmount,
    // }).onConflictDoUpdate({ target: [financeBudgetLines.category, financeBudgetLines.subcategory], set: { monthlyAmount: line.monthlyAmount, updatedAt: new Date() } }).run()
    return { success: true }
  })
}

// ----- helpers -----

// function nextMonth(yyyymm: string): string {
//   const [y, m] = yyyymm.split('-').map(Number)
//   return new Date(y, m, 1).toISOString().slice(0, 7) + '-01'
// }

// async function refreshFinanceKnowledge(db: any): Promise<void> {
//   const accounts = db.select().from(financeAccounts).where(eq(financeAccounts.active, true)).all()
//   const transactions = db.select().from(financeTransactions).all()
//   const debts = db.select().from(financeDebts).where(eq(financeDebts.active, true)).all()
//   const budget = db.select().from(financeBudgetLines).all()
//   writeAllFinanceKnowledge({ accounts, transactions, debts, budget })
// }
