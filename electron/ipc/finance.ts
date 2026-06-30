import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { and, desc, eq, gt, gte, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { BrowserWindow, type IpcMain, dialog } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import {
  appSettings,
  budgetRules,
  categorizationRules,
  financeAccounts,
  financeTransactions,
  forecastOverrides,
  fxRates
} from '../db/schema'
import { categorize, ingestCsvFolder } from '../integrations/finance'
import {
  countDuplicateTransactions,
  dedupeTransactions,
  mergeAccounts
} from '../integrations/finance-cleanup'
import { FATCA_THRESHOLD_SETTING_KEY, buildExpatTaxSummary } from '../integrations/finance-expat'
import { type ForecastResult, buildForecast } from '../integrations/finance-forecast'
import {
  BASE_CURRENCY_SETTING_KEY,
  DEFAULT_BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  getBaseCurrency,
  isSupportedCurrency,
  normalizeCurrency,
  upsertFxRate
} from '../integrations/finance-fx'
import { syncFxRates } from '../integrations/finance-fx-fetch'
import {
  type PropertyConfig,
  buildPropertyPnl,
  getPropertyConfig,
  setPropertyConfig
} from '../integrations/finance-property'
import {
  type RetirementConfig,
  buildRetirementProjection,
  setRetirementConfig
} from '../integrations/finance-retirement'
import {
  captureSnapshots,
  getNetWorthSnapshot,
  getNetWorthTrajectory,
  setAccountBalance
} from '../integrations/finance-snapshot'
import { auditSubscriptions } from '../integrations/finance-subscriptions'
import {
  getWatchedFolder,
  ingestWatchedFolderNow,
  startFinanceWatcher,
  stopFinanceWatcher
} from '../integrations/finance-watcher'
import { writeAllFinanceKnowledge } from '../knowledge/finance-extractor'
import { localYm, localYmd } from '../lib/dates'
import { DATA_DIR } from '../paths'

const DEFAULT_MONEY_FOLDER = join(homedir(), 'Documents', 'Money')
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validateGeoSince(since: string): string {
  if (!ISO_DATE_RE.test(since)) {
    throw new Error('Invalid since date. Expected YYYY-MM-DD.')
  }
  const parsed = new Date(`${since}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== since) {
    throw new Error('Invalid since date. Expected a real calendar date.')
  }
  if (since < '2000-01-01') {
    throw new Error('Invalid since date. Earliest supported date is 2000-01-01.')
  }
  const today = localYmd()
  if (since > today) {
    throw new Error('Invalid since date. Date cannot be in the future.')
  }
  return since
}

// Accepted transaction tax tags. Exported as a ReadonlySet so other write
// paths (e.g. the Claude Inbox approval flow in ipc/claude.ts) validate against
// the same set without being able to mutate it.
export const TAX_TAGS: ReadonlySet<string> = new Set([
  'tax:capex-airbnb',
  'tax:schedule-c-income',
  'tax:schedule-c-expense',
  'tax:schedule-e-income',
  'tax:schedule-e-expense',
  'tax:charitable',
  'tax:medical',
  'tax:home-office',
  'tax:personal',
  'tax:investment',
  'tax:foreign-tax',
  'tax:none'
])

export function getMoneyFolder(): string {
  try {
    const db = getDb()
    const row = db.select().from(appSettings).where(eq(appSettings.key, 'financeWatchFolder')).get()
    return row?.value || DEFAULT_MONEY_FOLDER
  } catch {
    return DEFAULT_MONEY_FOLDER
  }
}

const INBOX_DIR = join(DATA_DIR, 'finance-inbox')
const ARCHIVE_DIR = join(DATA_DIR, 'finance-archive')

function emitRulesReapplied(payload: {
  updated: number
  scanned: number
  source: 'save-rule' | 'delete-rule'
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('finance:rules-reapplied', payload)
  }
}

function scheduleReapplyRulesBackground(source: 'save-rule' | 'delete-rule'): void {
  setImmediate(() => {
    void reapplyRulesBackground()
      .then((result) => {
        emitRulesReapplied({ ...result, source })
      })
      .catch((e) => {
        console.error('[finance] background rule reapply failed:', e)
      })
  })
}

export function registerFinanceHandlers(ipcMain: IpcMain): void {
  // Ensure directories exist on first registration
  for (const d of [INBOX_DIR, ARCHIVE_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }

  // ── Ingest a folder of bank CSVs ──────────────────────────────────────────
  ipcMain.handle('finance:ingest-folder', async (_event, folder?: string) => {
    const inbox = folder || INBOX_DIR
    if (!existsSync(inbox)) {
      mkdirSync(inbox, { recursive: true })
      return { filesProcessed: 0, newTransactions: 0, duplicatesDropped: 0, perFile: [] }
    }

    const db = getDb()
    const rules = db.select().from(categorizationRules).orderBy(categorizationRules.priority).all()

    const result = await ingestCsvFolder(db, inbox, ARCHIVE_DIR, undefined, rules)

    // Refresh knowledge markdown after ingest
    try {
      await refreshFinanceKnowledge()
    } catch (e) {
      console.error('[finance] knowledge refresh failed:', e)
    }

    return result
  })

  // ── List transactions ─────────────────────────────────────────────────────
  ipcMain.handle(
    'finance:get-transactions',
    (
      _event,
      opts?: {
        month?: string
        category?: string
        accountId?: number
        limit?: number
      }
    ) => {
      const db = getDb()
      const lim = opts?.limit ?? 200
      const base = db.select().from(financeTransactions).orderBy(desc(financeTransactions.date))

      const month = opts?.month
      const cat = opts?.category
      const acct = opts?.accountId

      if (month && cat && acct) {
        return base
          .where(
            and(
              gte(financeTransactions.date, `${month}-01`),
              lt(financeTransactions.date, nextMonth(month)),
              eq(financeTransactions.category, cat),
              eq(financeTransactions.accountId, acct)
            )
          )
          .limit(lim)
          .all()
      }
      if (month && cat) {
        return base
          .where(
            and(
              gte(financeTransactions.date, `${month}-01`),
              lt(financeTransactions.date, nextMonth(month)),
              eq(financeTransactions.category, cat)
            )
          )
          .limit(lim)
          .all()
      }
      if (month && acct) {
        return base
          .where(
            and(
              gte(financeTransactions.date, `${month}-01`),
              lt(financeTransactions.date, nextMonth(month)),
              eq(financeTransactions.accountId, acct)
            )
          )
          .limit(lim)
          .all()
      }
      if (month) {
        return base
          .where(
            and(
              gte(financeTransactions.date, `${month}-01`),
              lt(financeTransactions.date, nextMonth(month))
            )
          )
          .limit(lim)
          .all()
      }
      if (cat) {
        return base.where(eq(financeTransactions.category, cat)).limit(lim).all()
      }
      if (acct) {
        return base.where(eq(financeTransactions.accountId, acct)).limit(lim).all()
      }
      return base.limit(lim).all()
    }
  )

  // ── Update a transaction (category / notes) ───────────────────────────────
  ipcMain.handle(
    'finance:update-transaction',
    (
      _event,
      id: number,
      updates: {
        category?: string
        subcategory?: string
        notes?: string
        accountId?: number | null
      }
    ) => {
      const db = getDb()
      db.update(financeTransactions).set(updates).where(eq(financeTransactions.id, id)).run()
      return { success: true }
    }
  )

  // ── Delete a transaction ──────────────────────────────────────────────────
  ipcMain.handle('finance:delete-transaction', (_event, id: number) => {
    const db = getDb()
    db.delete(financeTransactions).where(eq(financeTransactions.id, id)).run()
    return { success: true }
  })

  // ── List accounts ─────────────────────────────────────────────────────────
  ipcMain.handle('finance:get-accounts', () => {
    const db = getDb()
    return db.select().from(financeAccounts).all()
  })

  // ── Create / update account ───────────────────────────────────────────────
  ipcMain.handle(
    'finance:upsert-account',
    (
      _event,
      account: {
        id?: number
        name: string
        type: string
        isDebt?: boolean
        balance?: number
        currency?: string
        apr?: number
        minPayment?: number
        creditLimit?: number
      }
    ) => {
      const db = getDb()
      // Phase 11.1 — accept a supported ISO-4217 currency; anything unsupported
      // or blank falls back to USD so a bad code never lands in the ledger.
      const currency = isSupportedCurrency(account.currency)
        ? normalizeCurrency(account.currency)
        : DEFAULT_BASE_CURRENCY
      const payload = {
        name: account.name,
        type: account.type,
        isDebt: account.isDebt ?? false,
        balance: account.balance ?? 0,
        currency,
        apr: account.apr ?? 0,
        minPayment: account.minPayment ?? 0,
        creditLimit: account.creditLimit ?? null,
        updatedAt: new Date()
      }

      if (account.id) {
        db.update(financeAccounts).set(payload).where(eq(financeAccounts.id, account.id)).run()
        return { success: true, id: account.id }
      }
      const result = db.insert(financeAccounts).values(payload).run()
      return { success: true, id: Number(result.lastInsertRowid) }
    }
  )

  // ── Delete account ────────────────────────────────────────────────────────
  ipcMain.handle('finance:delete-account', (_event, id: number) => {
    const db = getDb()
    const transactionCountResult = db
      .select({ count: sql<number>`count(*)` })
      .from(financeTransactions)
      .where(eq(financeTransactions.accountId, id))
      .get()
    const transactionCount = Number(transactionCountResult?.count ?? 0)
    if (transactionCount > 0) {
      throw new Error(
        `Can't delete this account while ${transactionCount} transaction${transactionCount === 1 ? ' still references' : 's still reference'} it.`
      )
    }
    db.delete(financeAccounts).where(eq(financeAccounts.id, id)).run()
    return { success: true }
  })

  // ── Cleanup tools (Phase 4.7 #4): merge duplicate accounts, dedupe txns ────
  ipcMain.handle('finance:merge-accounts', (_event, sourceId: number, targetId: number) => {
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) {
      throw new Error('finance:merge-accounts: sourceId and targetId must be integers')
    }
    return { success: true, ...mergeAccounts(getRawSqlite(), sourceId, targetId) }
  })

  // Preview when `apply` is falsy (returns `removable`), apply when true
  // (returns `removed`). Kept as one handler so the UI previews then applies.
  ipcMain.handle('finance:dedupe-transactions', (_event, opts?: { apply?: boolean }) => {
    const sqlite = getRawSqlite()
    if (opts?.apply) return { applied: true as const, removed: dedupeTransactions(sqlite).removed }
    return { applied: false as const, removable: countDuplicateTransactions(sqlite) }
  })

  // ── Debt summary + avalanche projection ───────────────────────────────────
  ipcMain.handle('finance:get-debt-summary', () => {
    const db = getDb()
    const debts = db.select().from(financeAccounts).where(eq(financeAccounts.isDebt, true)).all()
    const projection = simulateAvalanche(debts, 500)
    return { debts, projection }
  })

  // ── Subscription audit (active, zombies, duplicates) ──────────────────────
  ipcMain.handle('finance:get-subscriptions', () => {
    const db = getDb()
    return auditSubscriptions(db)
  })

  // ── Geo / CR purpose summary across the whole ledger ──────────────────────
  // Aggregates first-class `geo` / `purpose` columns set during ingest and
  // returns data the Finance page renders as the "Geography" + "Costa Rica
  // purpose" cards.
  ipcMain.handle('finance:get-geo-summary', (_event, opts?: { since?: string }) => {
    const db = getDb()
    const cutoff = opts?.since ? validateGeoSince(opts.since) : null

    // SQL-aggregated geo breakdown (uses the indexed `geo` column).
    const geoRows = db
      .select({
        name: financeTransactions.geo,
        amount: sql<number>`ROUND(SUM(-${financeTransactions.amount}) * 100) / 100`,
        count: sql<number>`COUNT(*)`
      })
      .from(financeTransactions)
      .where(
        and(
          lt(financeTransactions.amount, 0),
          or(
            isNull(financeTransactions.category),
            and(
              ne(financeTransactions.category, 'Transfers'),
              ne(financeTransactions.category, 'Cash')
            )
          ),
          cutoff ? gte(financeTransactions.date, cutoff) : undefined
        )
      )
      .groupBy(financeTransactions.geo)
      .orderBy(sql`SUM(-${financeTransactions.amount}) DESC`)
      .all() as { name: string; amount: number; count: number }[]

    // Purpose breakdown for CR transactions only.
    const purposeRows = db
      .select({
        name: financeTransactions.purpose,
        amount: sql<number>`ROUND(SUM(-${financeTransactions.amount}) * 100) / 100`
      })
      .from(financeTransactions)
      .where(
        and(
          lt(financeTransactions.amount, 0),
          eq(financeTransactions.geo, 'CR'),
          sql`${financeTransactions.purpose} IS NOT NULL`,
          or(
            isNull(financeTransactions.category),
            and(
              ne(financeTransactions.category, 'Transfers'),
              ne(financeTransactions.category, 'Cash')
            )
          ),
          cutoff ? gte(financeTransactions.date, cutoff) : undefined
        )
      )
      .groupBy(financeTransactions.purpose)
      .orderBy(sql`SUM(-${financeTransactions.amount}) DESC`)
      .all() as { name: string | null; amount: number }[]

    const purpose = purposeRows
      .filter((r): r is { name: string; amount: number } => r.name !== null)
      .map((r) => ({ name: r.name, amount: r.amount }))

    const crCapex = purpose.find((p) => p.name === 'capex')?.amount ?? 0

    return { geo: geoRows, purpose, crCapex: Math.round(crCapex * 100) / 100, since: cutoff }
  })

  // ── Tax summary for a given year (Phase 4.3) ──────────────────────────────
  // Returns per-tag count + total signed amount for the requested calendar
  // year. Uses the (tax_year, tax_tag) index for fast aggregation. The UI
  // renders this as a year-end report; sums are signed (negative = expense).
  ipcMain.handle('finance:get-tax-summary', (_event, opts?: { year?: number }) => {
    const db = getDb()
    const now = new Date()
    const requested = Number.isFinite(opts?.year)
      ? Math.floor(opts!.year as number)
      : now.getFullYear()
    const year = Math.max(2000, Math.min(2100, requested))

    const rows = db
      .select({
        taxTag: financeTransactions.taxTag,
        count: sql<number>`COUNT(*)`,
        total: sql<number>`ROUND(SUM(${financeTransactions.amount}) * 100) / 100`
      })
      .from(financeTransactions)
      .where(eq(financeTransactions.taxYear, year))
      .groupBy(financeTransactions.taxTag)
      .orderBy(sql`SUM(ABS(${financeTransactions.amount})) DESC`)
      .all() as { taxTag: string; count: number; total: number }[]

    return { year, tags: rows }
  })

  // ── Override a transaction's tax tag (Phase 4.3) ──────────────────────────
  // Marks taxTagSource='user' so future re-tag passes won't overwrite it.
  ipcMain.handle('finance:set-transaction-tax-tag', (_event, id: number, taxTag: string) => {
    const db = getDb()
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: `Invalid transaction id: ${id}` }
    }
    // Whitelist accepted values to keep schema clean (shared TAX_TAGS).
    if (!TAX_TAGS.has(taxTag)) {
      return { success: false, error: `Unknown tax tag: ${taxTag}` }
    }
    const result = db
      .update(financeTransactions)
      .set({ taxTag, taxTagSource: 'user' })
      .where(eq(financeTransactions.id, id))
      .run()
    if (result.changes === 0) {
      return { success: false, error: `Transaction not found: ${id}` }
    }
    return { success: true }
  })

  // ── Tax-pack export (May 2026 strategic review Tier 2 #5) ─────────────────
  // Writes one CSV per non-`none` tax tag for the requested year into a
  // user-chosen folder. Filenames are stable / human-readable so the user
  // can drop the bundle straight into TurboTax / a CPA shared folder.
  ipcMain.handle('finance:export-tax-pack', async (_event, opts?: { year?: number }) => {
    try {
      const db = getDb()
      const now = new Date()
      const requested = Number.isFinite(opts?.year)
        ? Math.floor(opts!.year as number)
        : now.getFullYear()
      const year = Math.max(2000, Math.min(2100, requested))

      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: `Choose a folder for your ${year} tax pack`,
        properties: ['openDirectory', 'createDirectory']
      })
      if (canceled || filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const outDir = filePaths[0]

      const rows = db
        .select({
          id: financeTransactions.id,
          date: financeTransactions.date,
          amount: financeTransactions.amount,
          description: financeTransactions.description,
          accountId: financeTransactions.accountId,
          category: financeTransactions.category,
          subcategory: financeTransactions.subcategory,
          notes: financeTransactions.notes,
          taxTag: financeTransactions.taxTag,
          taxTagSource: financeTransactions.taxTagSource,
          geo: financeTransactions.geo,
          purpose: financeTransactions.purpose
        })
        .from(financeTransactions)
        .where(
          and(eq(financeTransactions.taxYear, year), ne(financeTransactions.taxTag, 'tax:none'))
        )
        .all()

      const accounts = db
        .select({ id: financeAccounts.id, name: financeAccounts.name })
        .from(financeAccounts)
        .all()
      const accountName = new Map(accounts.map((a) => [a.id, a.name]))

      function csvEscape(v: unknown): string {
        if (v == null) return ''
        const s = String(v)
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
        return s
      }

      const byTag = new Map<string, typeof rows>()
      for (const r of rows) {
        if (!byTag.has(r.taxTag)) byTag.set(r.taxTag, [])
        byTag.get(r.taxTag)!.push(r)
      }

      const HEADER = [
        'date',
        'amount',
        'description',
        'account',
        'category',
        'subcategory',
        'geo',
        'purpose',
        'tax_tag',
        'tax_tag_source',
        'notes'
      ]

      const written: Array<{ tag: string; file: string; count: number; total: number }> = []
      for (const [tag, txns] of byTag) {
        const slug = tag.replace(/^tax:/, '').replace(/[^a-z0-9-]+/gi, '-')
        const file = join(outDir, `compass-tax-${year}-${slug}.csv`)
        // Per-tag CSVs are pure transaction rows — every line conforms to
        // HEADER so the file is a clean import target for TurboTax / a
        // spreadsheet pivot. The summary lives in the manifest below.
        const lines: string[] = [HEADER.join(',')]
        let total = 0
        for (const t of txns) {
          total += t.amount
          lines.push(
            [
              csvEscape(t.date),
              csvEscape(t.amount.toFixed(2)),
              csvEscape(t.description),
              csvEscape(accountName.get(t.accountId ?? -1) ?? ''),
              csvEscape(t.category ?? ''),
              csvEscape(t.subcategory ?? ''),
              csvEscape(t.geo ?? ''),
              csvEscape(t.purpose ?? ''),
              csvEscape(t.taxTag),
              csvEscape(t.taxTagSource),
              csvEscape(t.notes ?? '')
            ].join(',')
          )
        }
        writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8')
        written.push({ tag, file, count: txns.length, total: Math.round(total * 100) / 100 })
      }

      // Manifest — single index of what was written, sums included.
      const manifestPath = join(outDir, `compass-tax-${year}-manifest.txt`)
      const manifestLines = [
        `Compass tax pack — ${year}`,
        `Exported ${new Date().toISOString()}`,
        '',
        ...written.map(
          (w) =>
            `${w.tag.padEnd(28)} ${String(w.count).padStart(5)} rows   total $${w.total.toFixed(2)}   ${w.file}`
        )
      ]
      writeFileSync(manifestPath, `${manifestLines.join('\n')}\n`, 'utf-8')

      return { success: true, year, dir: outDir, files: written, manifest: manifestPath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Net-worth snapshot (Phase 4.4) ────────────────────────────────────────
  // Returns latest balance per account + assets/liabilities/net totals + 30/90/365-day deltas.
  ipcMain.handle('finance:get-net-worth-snapshot', () => {
    return getNetWorthSnapshot(getRawSqlite())
  })

  // ── Net-worth trajectory ─────────────────────────────────────────────────
  // Returns every snapshot in the requested window. Caller (UI) groups by
  // account/date for the trajectory chart.
  ipcMain.handle(
    'finance:get-net-worth-trajectory',
    (_event, opts?: { sinceDays?: number; untilMs?: number }) => {
      const now = Date.now()
      const days = Number.isFinite(opts?.sinceDays) ? Math.floor(opts!.sinceDays as number) : 365
      const clamped = Math.min(3650, Math.max(1, days))
      const sinceMs = now - clamped * 24 * 60 * 60 * 1000

      // Validate untilMs: must be a finite positive number within a sane
      // window and >= sinceMs. Anything else falls back to "now".
      let untilMs = now
      if (
        Number.isFinite(opts?.untilMs) &&
        (opts!.untilMs as number) > 0 &&
        (opts!.untilMs as number) >= sinceMs &&
        (opts!.untilMs as number) <= now + 365 * 24 * 60 * 60 * 1000
      ) {
        untilMs = opts!.untilMs as number
      }

      return getNetWorthTrajectory(getRawSqlite(), { sinceMs, untilMs })
    }
  )

  // ── Capture today's snapshot for every account ───────────────────────────
  // Idempotent within a calendar day. Used by the "Capture snapshot" button
  // and by the nightly cron in cron.ts.
  ipcMain.handle('finance:capture-snapshot', () => {
    return captureSnapshots(getRawSqlite())
  })

  // ── Manually set an account's balance (writes a 'manual' snapshot) ───────
  // Used by the Accounts-tab "Set balance" UI for manual_asset accounts
  // (CR property, collectibles) and as an override for transaction-backed
  // accounts when the inferred value drifts from reality.
  ipcMain.handle('finance:set-account-balance', (_event, accountId: number, balance: number) => {
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { success: false, error: `Invalid account id: ${accountId}` }
    }
    if (!Number.isFinite(balance)) {
      return { success: false, error: `Invalid balance: ${balance}` }
    }
    // Sanity bound: ±$1B covers any realistic personal asset (CR property,
    // brokerage, retirement) and rejects garbage like Number.MAX_VALUE.
    const MAX_BALANCE = 1_000_000_000
    if (Math.abs(balance) > MAX_BALANCE) {
      return { success: false, error: `Balance out of range: ${balance}` }
    }
    try {
      const sqlite = getRawSqlite()
      const exists = sqlite
        .prepare('SELECT 1 FROM finance_accounts WHERE id = ? LIMIT 1')
        .get(accountId)
      if (!exists) {
        return { success: false, error: `Account not found: ${accountId}` }
      }
      setAccountBalance(sqlite, accountId, balance)
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Failed to set balance: ${message}` }
    }
  })

  // ── Multi-currency foundation (Phase 11.1) ───────────────────────────────
  // Base currency = the one net worth + forecast roll up to. The supported
  // list drives the Accounts/Settings currency pickers.
  ipcMain.handle('finance:get-currency-settings', () => {
    return {
      baseCurrency: getBaseCurrency(getRawSqlite()),
      supported: SUPPORTED_CURRENCIES
    }
  })

  // Set the user's base currency. Rejects anything not in the supported set so
  // a typo can't silently strand every total as "unconverted".
  ipcMain.handle('finance:set-base-currency', (_event, code: string) => {
    if (!isSupportedCurrency(code)) {
      return { success: false, error: `Unsupported currency: ${code}` }
    }
    const normalized = normalizeCurrency(code)
    const db = getDb()
    db.insert(appSettings)
      .values({ key: BASE_CURRENCY_SETTING_KEY, value: normalized, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: normalized, updatedAt: new Date() }
      })
      .run()
    return { success: true, baseCurrency: normalized }
  })

  // Set an account's native currency and cascade it to that account's
  // transactions (which are denominated in the account's currency by design).
  ipcMain.handle('finance:set-account-currency', (_event, accountId: number, code: string) => {
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { success: false, error: `Invalid account id: ${accountId}` }
    }
    if (!isSupportedCurrency(code)) {
      return { success: false, error: `Unsupported currency: ${code}` }
    }
    const currency = normalizeCurrency(code)
    const db = getDb()
    const exists = db
      .select({ id: financeAccounts.id })
      .from(financeAccounts)
      .where(eq(financeAccounts.id, accountId))
      .get()
    if (!exists) {
      return { success: false, error: `Account not found: ${accountId}` }
    }
    db.update(financeAccounts)
      .set({ currency, updatedAt: new Date() })
      .where(eq(financeAccounts.id, accountId))
      .run()
    const updated = db
      .update(financeTransactions)
      .set({ currency })
      .where(eq(financeTransactions.accountId, accountId))
      .run()
    return { success: true, currency, transactionsUpdated: Number(updated.changes ?? 0) }
  })

  // Every stored FX rate, latest day first. Powers the manual-rate panel and
  // the "X accounts unconverted — add a rate" prompt.
  ipcMain.handle('finance:get-fx-rates', () => {
    const db = getDb()
    const rows = db
      .select()
      .from(fxRates)
      .orderBy(desc(fxRates.date), fxRates.base, fxRates.quote)
      .all()
    // `fetchedAt` is a Drizzle `timestamp_ms` column → a `Date` on select, but
    // the preload/renderer contract is epoch ms (`number | null`). Normalize so
    // consumers that treat it as a number don't break.
    return rows.map((r) => ({ ...r, fetchedAt: r.fetchedAt ? r.fetchedAt.getTime() : null }))
  })

  // Manually record an FX rate (units of `quote` per 1 unit of `base`). The
  // automated daily fetch (Phase 11.1b) writes the same table with source
  // 'erapi'; this is the no-network path so conversion works immediately.
  ipcMain.handle(
    'finance:set-fx-rate',
    (_event, input: { date: string; base: string; quote: string; rate: number }) => {
      const date = input?.date ?? ''
      if (!ISO_DATE_RE.test(date)) {
        return { success: false, error: 'Invalid date. Expected YYYY-MM-DD.' }
      }
      if (!isSupportedCurrency(input?.base) || !isSupportedCurrency(input?.quote)) {
        return { success: false, error: 'Unsupported base/quote currency.' }
      }
      const base = normalizeCurrency(input.base)
      const quote = normalizeCurrency(input.quote)
      if (base === quote) {
        return { success: false, error: 'Base and quote must differ.' }
      }
      const rate = input?.rate
      // Reject garbage: must be finite, positive, and within a sane band
      // (covers ₡/$ ≈ 500 and COP/$ ≈ 4000 with headroom; rejects 0 / Infinity).
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
        return { success: false, error: `Invalid rate: ${rate}` }
      }
      upsertFxRate(getRawSqlite(), { date, base, quote, rate, source: 'manual' })
      return { success: true }
    }
  )

  // Pull today's rates from the FX provider (Phase 11.1b). Main-process network
  // call; on failure the existing rates are left untouched and the error is
  // surfaced to the UI. The daily cron calls the same `syncFxRates`.
  ipcMain.handle('finance:refresh-fx-rates', async () => {
    try {
      const result = await syncFxRates(getRawSqlite())
      return { success: true, updated: result.updated, date: result.date }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Failed to refresh rates: ${message}` }
    }
  })

  // ── CR property / Airbnb P&L + depreciation (Phase 11.3) ─────────────────
  // Pure assembly over already-tagged rows (geo/purpose/taxTag), valued in the
  // base currency via the FX snapshot. Config (placed-in-service / land / basis /
  // recovery years) lives in app_settings.
  ipcMain.handle('finance:get-property-pnl', () => {
    const sqlite = getRawSqlite()
    return buildPropertyPnl(sqlite, getPropertyConfig(sqlite))
  })

  ipcMain.handle(
    'finance:set-property-config',
    (_event, rawInput?: Partial<PropertyConfig> | null) => {
      // Guard the IPC boundary: a null / non-object payload would make the `in`
      // checks below throw a TypeError and crash the handler. Treat anything
      // that isn't a plain object as an empty (no-op) patch.
      const input: Partial<PropertyConfig> =
        rawInput && typeof rawInput === 'object' ? rawInput : {}
      const patch: Partial<PropertyConfig> = {}
      const MAX = 1_000_000_000

      if ('placedInService' in input) {
        const v = input.placedInService
        if (v != null && v !== '' && !ISO_DATE_RE.test(v)) {
          return { success: false, error: 'Invalid placed-in-service date. Expected YYYY-MM-DD.' }
        }
        patch.placedInService = v ? v : null
      }
      if ('landValue' in input) {
        const v = Number(input.landValue)
        if (!Number.isFinite(v) || v < 0 || v > MAX) {
          return { success: false, error: `Invalid land value: ${input.landValue}` }
        }
        patch.landValue = v
      }
      if ('recoveryYears' in input) {
        const v = Number(input.recoveryYears)
        // 27.5 (US GDS) / 30 (foreign ADS) / 40 (pre-2018 ADS) are the real values;
        // bound to a sane (0, 100] band.
        if (!Number.isFinite(v) || v <= 0 || v > 100) {
          return { success: false, error: `Invalid recovery years: ${input.recoveryYears}` }
        }
        patch.recoveryYears = v
      }
      if ('basisOverride' in input) {
        const raw = input.basisOverride
        if (raw == null) {
          patch.basisOverride = null
        } else {
          const v = Number(raw)
          if (!Number.isFinite(v) || v < 0 || v > MAX) {
            return { success: false, error: `Invalid basis override: ${raw}` }
          }
          patch.basisOverride = v
        }
      }

      setPropertyConfig(getRawSqlite(), patch)
      return { success: true, config: getPropertyConfig(getRawSqlite()) }
    }
  )

  // ── Foreign-account & expat-tax surface (Phase 11.2) ─────────────────────
  // FBAR/FATCA aggregation + foreign-tax-credit ledger, assembled from balances
  // + tagged rows. Account IDENTIFIERS live in the `foreign-accounts` vault
  // category — they never flow through this summary.
  ipcMain.handle('finance:get-expat-tax-summary', () => {
    return buildExpatTaxSummary(getRawSqlite(), new Date().getFullYear())
  })

  // Mark/unmark an account as a foreign financial account (drives FBAR/FATCA).
  ipcMain.handle('finance:set-account-foreign', (_event, accountId: number, isForeign: boolean) => {
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { success: false, error: `Invalid account id: ${accountId}` }
    }
    // IPC input is untrusted: require a real boolean. `Boolean('false')` is
    // truthy, so coercing a stray string could silently flip the flag to true.
    if (typeof isForeign !== 'boolean') {
      return { success: false, error: 'isForeign must be a boolean.' }
    }
    const db = getDb()
    const exists = db
      .select({ id: financeAccounts.id })
      .from(financeAccounts)
      .where(eq(financeAccounts.id, accountId))
      .get()
    if (!exists) {
      return { success: false, error: `Account not found: ${accountId}` }
    }
    db.update(financeAccounts)
      .set({ isForeign, updatedAt: new Date() })
      .where(eq(financeAccounts.id, accountId))
      .run()
    return { success: true, isForeign }
  })

  // Set the FATCA reporting threshold (varies by filing status + residence; the
  // user picks the value that applies to them).
  ipcMain.handle('finance:set-fatca-threshold', (_event, value: number) => {
    const v = Number(value)
    if (!Number.isFinite(v) || v <= 0 || v > 100_000_000) {
      return { success: false, error: `Invalid FATCA threshold: ${value}` }
    }
    const db = getDb()
    db.insert(appSettings)
      .values({ key: FATCA_THRESHOLD_SETTING_KEY, value: String(v), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: String(v), updatedAt: new Date() }
      })
      .run()
    return { success: true, threshold: v }
  })

  // ── Long-horizon retirement projection (Phase 11.4) ──────────────────────
  // Multi-decade accumulation → decumulation against SS + Airbnb income, with a
  // sequence-of-returns stress path. Config in app_settings; starting balance
  // auto-sourced from net worth unless overridden.
  ipcMain.handle('finance:get-retirement-projection', () => {
    return buildRetirementProjection(getRawSqlite(), new Date().getFullYear())
  })

  ipcMain.handle(
    'finance:set-retirement-config',
    (_event, raw?: Partial<RetirementConfig> | null) => {
      // Guard the IPC boundary (a non-object would break the field loop below).
      const input: Partial<RetirementConfig> = raw && typeof raw === 'object' ? raw : {}
      const patch: Partial<RetirementConfig> = {}

      // (key, min, max) bounds. `startingAssets` is special (nullable override).
      const NUMERIC: Array<[keyof RetirementConfig, number, number]> = [
        ['currentAge', 0, 120],
        ['retirementAge', 0, 120],
        ['horizonAge', 1, 120],
        ['annualContribution', 0, 100_000_000],
        ['realReturnPct', -50, 50],
        ['annualSpending', 0, 100_000_000],
        ['ssMonthlyAtFra', 0, 1_000_000],
        ['ssClaimAge', 62, 70],
        ['fra', 62, 70],
        ['airbnbAnnualNet', 0, 100_000_000],
        ['otherAnnualIncome', 0, 100_000_000],
        ['stressReturnPct', -50, 50],
        ['stressYears', 0, 60]
      ]
      for (const [key, min, max] of NUMERIC) {
        if (!(key in input)) continue
        const v = Number(input[key])
        if (!Number.isFinite(v) || v < min || v > max) {
          return { success: false, error: `Invalid ${key}: ${input[key]}` }
        }
        patch[key] = v as never
      }
      if ('startingAssets' in input) {
        const raw2 = input.startingAssets
        if (raw2 == null) {
          patch.startingAssets = null
        } else {
          const v = Number(raw2)
          if (!Number.isFinite(v) || v < 0 || v > 1_000_000_000) {
            return { success: false, error: `Invalid startingAssets: ${raw2}` }
          }
          patch.startingAssets = v
        }
      }

      setRetirementConfig(getRawSqlite(), patch)
      return { success: true }
    }
  )

  // ── 90-day cash-flow forecast (Phase 4.5) ─────────────────────────────────
  // Combines subscriptions + recurring income + debt minimums + calendar
  // bills + user overrides into a per-account daily trajectory. Starting
  // balances come from the latest balance snapshot per account (Phase 4.4).
  ipcMain.handle(
    'finance:get-forecast',
    (_event, opts?: { windowDays?: number; lowCashThreshold?: number }): ForecastResult => {
      const sqlite = getRawSqlite()
      const db = getDb()
      const days = Number.isFinite(opts?.windowDays) ? Math.floor(opts!.windowDays as number) : 90
      const windowDays = Math.min(365, Math.max(7, days))

      // Clamp threshold to a sane range — negative values are nonsense and
      // huge values would defeat the warning.
      const rawThreshold = Number.isFinite(opts?.lowCashThreshold)
        ? (opts!.lowCashThreshold as number)
        : 500
      const lowCashThreshold = Math.max(0, Math.min(1_000_000_000, rawThreshold))

      // Build startingBalances for EVERY account — using the latest snapshot
      // when available, defaulting to 0 otherwise. Without this, accounts
      // with no snapshot yet (brand-new install or accounts created after
      // the last cron run) would be omitted entirely from the trajectory
      // and low-cash detection.
      const accounts = sqlite.prepare('SELECT id FROM finance_accounts').all() as Array<{
        id: number
      }>
      const latest = sqlite
        .prepare(
          `SELECT s.account_id, s.balance
             FROM finance_balance_snapshots s
             JOIN (
               SELECT account_id, MAX(captured_at) AS m
                 FROM finance_balance_snapshots GROUP BY account_id
             ) latest ON latest.account_id = s.account_id AND latest.m = s.captured_at`
        )
        .all() as Array<{ account_id: number; balance: number }>
      const balanceByAccount = new Map<number, number>()
      for (const r of latest) balanceByAccount.set(r.account_id, r.balance)

      const startingBalances: Record<number, number> = {}
      for (const a of accounts) startingBalances[a.id] = balanceByAccount.get(a.id) ?? 0

      return buildForecast(db, sqlite, startingBalances, {
        windowDays,
        lowCashThreshold
      })
    }
  )

  // ── Upsert a forecast override ───────────────────────────────────────────
  // `label` is required and identifies WHICH event on (accountId, date) the
  // override applies to. The DB enforces uniqueness on (accountId, date,
  // label) via the index added in migration 0008, so the upsert is atomic.
  ipcMain.handle(
    'finance:set-forecast-override',
    (
      _event,
      override: {
        accountId: number
        date: string
        label: string
        kind: 'skip' | 'shift' | 'override'
        amount?: number | null
        shiftToDate?: string | null
      }
    ) => {
      if (!Number.isInteger(override.accountId) || override.accountId <= 0) {
        return { success: false, error: `Invalid account id: ${override.accountId}` }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(override.date)) {
        return { success: false, error: `Invalid date: ${override.date}` }
      }
      if (typeof override.label !== 'string' || override.label.length === 0) {
        return { success: false, error: 'Label required to identify the event being overridden' }
      }
      if (override.kind !== 'skip' && override.kind !== 'shift' && override.kind !== 'override') {
        return { success: false, error: `Invalid kind: ${override.kind}` }
      }
      if (override.kind === 'shift') {
        if (!override.shiftToDate || !/^\d{4}-\d{2}-\d{2}$/.test(override.shiftToDate)) {
          return { success: false, error: `Invalid shiftToDate: ${override.shiftToDate}` }
        }
      }
      if (override.kind === 'override') {
        if (override.amount == null || !Number.isFinite(override.amount)) {
          return { success: false, error: 'Override amount required and must be finite' }
        }
      }
      try {
        const db = getDb()
        // Atomic upsert via INSERT … ON CONFLICT DO UPDATE on the unique
        // (account_id, date, label) index. No race window; no transaction
        // ceremony needed.
        db.insert(forecastOverrides)
          .values({
            accountId: override.accountId,
            date: override.date,
            label: override.label,
            kind: override.kind,
            amount: override.amount ?? null,
            shiftToDate: override.shiftToDate ?? null,
            createdAt: new Date()
          })
          .onConflictDoUpdate({
            target: [forecastOverrides.accountId, forecastOverrides.date, forecastOverrides.label],
            set: {
              kind: override.kind,
              amount: override.amount ?? null,
              shiftToDate: override.shiftToDate ?? null,
              createdAt: new Date()
            }
          })
          .run()
        return { success: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Failed to save override: ${message}` }
      }
    }
  )

  // ── Delete a forecast override (revert to auto-projected) ─────────────────
  // Requires `label` so we can target a specific event in a same-day stack.
  ipcMain.handle(
    'finance:delete-forecast-override',
    (_event, accountId: number, date: string, label: string) => {
      if (!Number.isInteger(accountId) || accountId <= 0) {
        return { success: false, error: `Invalid account id: ${accountId}` }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { success: false, error: `Invalid date: ${date}` }
      }
      if (typeof label !== 'string' || label.length === 0) {
        return { success: false, error: 'Label required to identify the override' }
      }
      try {
        const db = getDb()
        const result = db
          .delete(forecastOverrides)
          .where(
            and(
              eq(forecastOverrides.accountId, accountId),
              eq(forecastOverrides.date, date),
              eq(forecastOverrides.label, label)
            )
          )
          .run()
        return { success: true, removed: result.changes }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Failed to delete override: ${message}` }
      }
    }
  )

  // ── Upcoming payments (Dashboard "Payments Due" card) ────────────────────
  // Returns debt accounts whose payment_due_date is within the next
  // `daysAhead` days (default 14), sorted by date ascending. Past-due dates
  // are included too so the user sees them on the Dashboard until paid.
  ipcMain.handle('finance:get-upcoming-payments', (_event, daysAhead = 14) => {
    const db = getDb()
    const debts = db.select().from(financeAccounts).where(eq(financeAccounts.isDebt, true)).all()
    const normalizedDaysAhead = Number.isFinite(daysAhead) ? Math.floor(daysAhead) : 14
    const clampedDaysAhead = Math.min(365, Math.max(0, normalizedDaysAhead))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const cutoff = new Date(today)
    cutoff.setDate(cutoff.getDate() + clampedDaysAhead)
    const upcoming = debts
      .filter((d): d is typeof d & { paymentDueDate: string } => Boolean(d.paymentDueDate))
      .map((d) => {
        const due = new Date(`${d.paymentDueDate}T00:00:00`)
        const daysRemaining = Math.round((due.getTime() - today.getTime()) / 86_400_000)
        return {
          id: d.id,
          name: d.name,
          institution: d.institution,
          paymentDueDate: d.paymentDueDate,
          minPayment: d.minPayment ?? 0,
          balance: d.balance ?? 0,
          daysRemaining
        }
      })
      .filter((p) => {
        const due = new Date(`${p.paymentDueDate}T00:00:00`)
        return due.getTime() <= cutoff.getTime()
      })
      .sort((a, b) => (a.paymentDueDate < b.paymentDueDate ? -1 : 1))
    return upcoming
  })

  // ── Budget status (actual vs planned for a month) ─────────────────────────
  ipcMain.handle('finance:get-budget-status', (_event, month?: string) => {
    const db = getDb()
    const m = month ?? localYm()
    const budget = db.select().from(budgetRules).all()
    const txns = db
      .select()
      .from(financeTransactions)
      .where(
        and(gte(financeTransactions.date, `${m}-01`), lt(financeTransactions.date, nextMonth(m)))
      )
      .all()
    return computeBudgetStatus(budget, txns)
  })

  // ── Set a budget line ─────────────────────────────────────────────────────
  ipcMain.handle(
    'finance:set-budget',
    (
      _event,
      line: {
        category: string
        subcategory?: string
        monthlyAmount: number
      }
    ) => {
      const db = getDb()
      const existing = db
        .select()
        .from(budgetRules)
        .where(eq(budgetRules.category, line.category))
        .all()
        .find((r) => (r.subcategory ?? '') === (line.subcategory ?? ''))

      if (existing) {
        db.update(budgetRules)
          .set({ monthlyAmount: line.monthlyAmount, updatedAt: new Date() })
          .where(eq(budgetRules.id, existing.id))
          .run()
      } else {
        db.insert(budgetRules)
          .values({
            category: line.category,
            subcategory: line.subcategory ?? null,
            monthlyAmount: line.monthlyAmount,
            updatedAt: new Date()
          })
          .run()
      }
      return { success: true }
    }
  )

  // ── Categorization rules ──────────────────────────────────────────────────
  ipcMain.handle('finance:get-rules', () => {
    const db = getDb()
    return db.select().from(categorizationRules).orderBy(categorizationRules.priority).all()
  })

  ipcMain.handle(
    'finance:save-rule',
    (
      _event,
      rule: {
        id?: number
        pattern: string
        category: string
        subcategory?: string
        priority?: number
      }
    ) => {
      const db = getDb()
      const payload = {
        pattern: rule.pattern,
        category: rule.category,
        subcategory: rule.subcategory ?? null,
        priority: rule.priority ?? 0
      }
      if (rule.id) {
        db.update(categorizationRules).set(payload).where(eq(categorizationRules.id, rule.id)).run()
      } else {
        db.insert(categorizationRules).values(payload).run()
      }
      // Re-apply rules in background so existing transactions stay in sync
      scheduleReapplyRulesBackground('save-rule')
      return { success: true }
    }
  )

  ipcMain.handle('finance:delete-rule', (_event, id: number) => {
    const db = getDb()
    db.delete(categorizationRules).where(eq(categorizationRules.id, id)).run()
    // Re-apply rules in background so existing transactions stay in sync
    scheduleReapplyRulesBackground('delete-rule')
    return { success: true }
  })

  ipcMain.handle('finance:reapply-rules', async () => {
    return reapplyRulesBackground()
  })

  // ── Get inbox path ────────────────────────────────────────────────────────
  ipcMain.handle('finance:get-inbox-path', () => INBOX_DIR)

  // ── Watched folder (~/Documents/Money by default) ─────────────────────────
  ipcMain.handle('finance:get-watch-folder', () => ({
    path: getMoneyFolder(),
    isWatching: getWatchedFolder() !== null,
    exists: existsSync(getMoneyFolder())
  }))

  ipcMain.handle('finance:set-watch-folder', async (_event, folder: string | null) => {
    const db = getDb()
    if (folder) {
      db.insert(appSettings)
        .values({ key: 'financeWatchFolder', value: folder, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: folder, updatedAt: new Date() }
        })
        .run()
    } else {
      db.delete(appSettings).where(eq(appSettings.key, 'financeWatchFolder')).run()
    }
    await startFinanceWatcher(folder ?? getMoneyFolder())
    return { success: true, path: getMoneyFolder() }
  })

  ipcMain.handle('finance:pick-watch-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Pick a folder to watch for finance documents',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getMoneyFolder()
    })
    if (canceled || filePaths.length === 0) return { canceled: true }
    const folder = filePaths[0]
    const db = getDb()
    db.insert(appSettings)
      .values({ key: 'financeWatchFolder', value: folder, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: folder, updatedAt: new Date() }
      })
      .run()
    await startFinanceWatcher(folder)
    return { canceled: false, path: folder }
  })

  ipcMain.handle('finance:ingest-watched-now', async () => {
    const out = await ingestWatchedFolderNow()
    try {
      await refreshFinanceKnowledge()
    } catch (e) {
      console.error('[finance] knowledge refresh failed:', e)
    }
    return out
  })

  ipcMain.handle('finance:stop-watching', async () => {
    await stopFinanceWatcher()
    return { success: true }
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nextMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number)
  const d = new Date(y, m, 1) // month is 0-indexed in Date; m is already 1-indexed so this gives next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

type DebtRow = {
  id: number
  name: string
  balance: number | null
  apr: number | null
  minPayment: number | null
}

function simulateAvalanche(
  debts: DebtRow[],
  extraMonthly: number
): { month: number; balance: number }[] {
  if (!debts.length) return []

  // Sort highest APR first (avalanche strategy)
  const cards = debts
    .filter((d) => (d.balance ?? 0) > 0)
    .map((d) => ({
      name: d.name,
      balance: d.balance ?? 0,
      apr: d.apr ?? 0,
      min: d.minPayment ?? 0
    }))
    .sort((a, b) => b.apr - a.apr)

  if (!cards.length) return []

  const projection: { month: number; balance: number }[] = []
  let month = 0

  while (cards.some((c) => c.balance > 0) && month < 120) {
    month++
    const totalMin = cards.reduce((s, c) => s + (c.balance > 0 ? c.min : 0), 0)
    let extra = Math.max(0, extraMonthly - totalMin) // extra beyond minimums

    for (const c of cards) {
      if (c.balance <= 0) continue
      // Monthly interest
      c.balance += c.balance * (c.apr / 12)
      // Pay minimum
      const pay = Math.min(c.balance, c.min + extra)
      c.balance = Math.max(0, c.balance - pay)
      extra = Math.max(0, extra - Math.max(0, pay - c.min))
    }

    const totalBalance = cards.reduce((s, c) => s + c.balance, 0)
    projection.push({ month, balance: Math.round(totalBalance * 100) / 100 })
  }

  return projection
}

type BudgetRuleRow = {
  id: number
  category: string
  subcategory: string | null
  monthlyAmount: number
}
type TxnRow = { category: string | null; subcategory: string | null; amount: number }

function computeBudgetStatus(
  budget: BudgetRuleRow[],
  txns: TxnRow[]
): {
  lines: Array<{
    category: string
    subcategory?: string
    monthlyAmount: number
    actual: number
    variance: number
    pct: number
  }>
  totals: { budgeted: number; actual: number }
} {
  // Sum actual spend by category+subcategory (expenses only, skip transfers)
  const actualMap: Record<string, number> = {}
  for (const t of txns) {
    if ((t.amount ?? 0) >= 0) continue // only expenses (negative amounts)
    if (t.category === 'Transfers') continue
    const k = `${t.category ?? 'Uncategorized'}|${t.subcategory ?? ''}`
    actualMap[k] = (actualMap[k] ?? 0) + Math.abs(t.amount)
  }

  const lines = budget.map((b) => {
    const k = `${b.category}|${b.subcategory ?? ''}`
    const actual = actualMap[k] ?? 0
    return {
      category: b.category,
      subcategory: b.subcategory ?? undefined,
      monthlyAmount: b.monthlyAmount,
      actual,
      variance: b.monthlyAmount - actual,
      pct: b.monthlyAmount > 0 ? actual / b.monthlyAmount : 0
    }
  })

  const totals = {
    budgeted: lines.reduce((s, l) => s + l.monthlyAmount, 0),
    actual: lines.reduce((s, l) => s + l.actual, 0)
  }

  return { lines, totals }
}

/**
 * Re-run categorize() over ALL existing transactions in batches of 500.
 * Only writes rows where the computed category actually differs from the
 * stored one — safe to call at any time (idempotent).
 * Returns { updated, scanned }.
 */
async function reapplyRulesBackground(): Promise<{ updated: number; scanned: number }> {
  const BATCH = 500
  const db = getDb()
  const rules = db.select().from(categorizationRules).orderBy(categorizationRules.priority).all()
  const ruleArgs = rules.map((r) => ({
    pattern: r.pattern,
    category: r.category,
    subcategory: r.subcategory
  }))

  let lastSeenId = 0
  let scanned = 0
  let updated = 0

  while (true) {
    const rows = db
      .select()
      .from(financeTransactions)
      .where(gt(financeTransactions.id, lastSeenId))
      .orderBy(financeTransactions.id)
      .limit(BATCH)
      .all()
    if (rows.length === 0) break

    for (const row of rows) {
      const currentCategory = row.category ?? 'Uncategorized'
      const currentSubcategory = row.subcategory ?? null
      const isCurrentlyUncategorized =
        currentCategory === 'Uncategorized' && currentSubcategory == null

      // Run categorize on a synthetic RawTxn with just the description.
      // Clear category/subcategory so rule application is evaluated independently
      // from any existing manual categorization on the transaction.
      const fakeRaw = [
        {
          date: row.date,
          amount: row.amount,
          description: row.description,
          account: '',
          category: undefined,
          subcategory: undefined,
          sourceFile: '',
          hash: row.hash
        }
      ]
      const [result] = ruleArgs.length ? categorize(fakeRaw, ruleArgs) : fakeRaw

      const matchedCategory = result.category ?? 'Uncategorized'
      const matchedSubcategory = result.subcategory ?? null
      const hasRuleMatch = matchedCategory !== 'Uncategorized' || matchedSubcategory !== null

      if (isCurrentlyUncategorized && hasRuleMatch) {
        db.update(financeTransactions)
          .set({ category: matchedCategory, subcategory: matchedSubcategory })
          .where(eq(financeTransactions.id, row.id))
          .run()
        updated++
      }
    }

    scanned += rows.length
    lastSeenId = rows[rows.length - 1].id
    if (rows.length < BATCH) break

    // Yield to keep the event loop responsive while processing large datasets.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }

  return { updated, scanned }
}

async function refreshFinanceKnowledge(): Promise<void> {
  const db = getDb()
  const accounts = db.select().from(financeAccounts).all()
  const transactions = db.select().from(financeTransactions).all()
  const debts = accounts.filter((a) => a.isDebt)
  const budget = db.select().from(budgetRules).all()

  writeAllFinanceKnowledge({
    accounts: accounts.map((a) => ({
      name: a.name,
      type: a.type,
      institution: a.institution ?? '',
      active: true,
      notes: null
    })),
    transactions: transactions.map((t) => ({
      date: t.date,
      amount: t.amount,
      description: t.description,
      category: t.category ?? 'Uncategorized',
      subcategory: t.subcategory
    })),
    debts: debts.map((d) => ({
      name: d.name,
      balance: d.balance ?? 0,
      apr: d.apr ?? 0,
      minPayment: d.minPayment ?? 0
    })),
    budget: budget.map((b) => ({
      category: b.category,
      subcategory: b.subcategory,
      monthlyAmount: b.monthlyAmount
    }))
  })
}
