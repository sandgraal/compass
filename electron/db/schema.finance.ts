/**
 * Finance schema additions — paste these table defs into electron/db/schema.ts
 * and re-run `npm run db:generate && npm run db:migrate`.
 *
 * Conventions match the existing schema:
 *   - integer PKs with autoIncrement
 *   - timestamp_ms for dates we sort/range on
 *   - text ISO date for dates we filter by month/day
 *   - syncedAt / createdAt with $defaultFn
 */

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// One row per account (checking, savings, credit card). Account *credentials*
// (numbers, logins) live in the Vault under category 'financial' — this table
// only holds the human label and metadata.
export const financeAccounts = sqliteTable('finance_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(), // 'Chase Sapphire'
  type: text('type').notNull(), // 'checking' | 'savings' | 'credit_card'
  institution: text('institution').notNull().default(''), // 'Chase'
  active: integer('active', { mode: 'boolean' }).default(true),
  vaultRef: text('vault_ref'), // optional pointer to a vault entry id
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const financeTransactions = sqliteTable('finance_transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  hash: text('hash').notNull().unique(), // sha1(date|amount|desc|account) — dedupe key
  date: text('date').notNull(), // ISO 'YYYY-MM-DD' for date-range filtering
  amount: real('amount').notNull(), // negative = expense, positive = income
  description: text('description').notNull(),
  accountId: integer('account_id').references(() => financeAccounts.id),
  category: text('category').notNull().default('Uncategorized'),
  subcategory: text('subcategory'),
  notes: text('notes'),
  sourceFile: text('source_file'),
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const financeDebts = sqliteTable('finance_debts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(), // 'Chase Sapphire — main card'
  accountId: integer('account_id').references(() => financeAccounts.id),
  balance: real('balance').notNull(),
  apr: real('apr').notNull(), // 0.2299 = 22.99%
  minPayment: real('min_payment').notNull(),
  active: integer('active', { mode: 'boolean' }).default(true),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const financeBudgetLines = sqliteTable('finance_budget_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull(), // matches financeTransactions.category
  subcategory: text('subcategory'),
  monthlyAmount: real('monthly_amount').notNull(),
  notes: text('notes'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// Merchant-string → category rules. First substring match wins (case-insensitive).
// Maintained by the categorizer; user-corrected categories get appended here.
export const financeCategoryRules = sqliteTable('finance_category_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull().unique(), // 'starbucks' (lowercased)
  category: text('category').notNull(),
  subcategory: text('subcategory'),
  priority: integer('priority').default(100), // lower = checked first
  source: text('source').default('seed') // 'seed' | 'user' | 'auto'
})

// Optional: app-level finance settings (take-home pay, target debt payment, etc.)
// — could also reuse the existing appSettings table.
export const financeSettings = sqliteTable('finance_settings', {
  key: text('key').primaryKey(), // 'monthly_take_home', 'monthly_debt_target'
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})
