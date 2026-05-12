import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ---- Integrations ----
export const integrations = sqliteTable('integrations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull().unique(), // 'google' | 'github'
  connectedAt: integer('connected_at', { mode: 'timestamp_ms' }),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
  status: text('status').notNull().default('disconnected'), // 'connected' | 'disconnected' | 'error'
  scopes: text('scopes'), // JSON array
  errorMessage: text('error_message'),
  // Per-integration sync interval in minutes. 0 = manual only. Default 15.
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(15)
})

// ---- Sync Events ----
export const syncEvents = sqliteTable('sync_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  integrationId: integer('integration_id').references(() => integrations.id),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
  recordsUpdated: integer('records_updated').default(0),
  errors: text('errors')
})

// ---- Checklist Items ----
export const checklistItems = sqliteTable('checklist_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  listType: text('list_type').notNull(), // 'daily' | 'weekly' | 'monthly'
  listDate: text('list_date').notNull(), // ISO date string: '2025-01-15'
  title: text('title').notNull(),
  body: text('body'),
  checked: integer('checked', { mode: 'boolean' }).default(false),
  status: text('status').default('unchecked'), // 'unchecked' | 'in_progress' | 'done' | 'snoozed'
  category: text('category').default('personal'), // 'morning' | 'work' | 'personal' | 'evening'
  sortOrder: integer('sort_order').default(0),
  dueDate: text('due_date'),
  source: text('source').default('manual'), // 'manual' | 'github' | 'calendar' | 'gmail'
  sourceId: text('source_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
})

// ---- Checklist Templates ----
export const checklistTemplates = sqliteTable('checklist_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  listType: text('list_type').notNull().unique(),
  contentMd: text('content_md').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Calendar Events ----
export const calendarEvents = sqliteTable('calendar_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // 'google' | 'apple'
  externalId: text('external_id').notNull().unique(),
  title: text('title').notNull(),
  startAt: integer('start_at', { mode: 'timestamp_ms' }),
  endAt: integer('end_at', { mode: 'timestamp_ms' }),
  allDay: integer('all_day', { mode: 'boolean' }).default(false),
  location: text('location'),
  description: text('description'),
  htmlLink: text('html_link'),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- GitHub Items ----
export const githubItems = sqliteTable('github_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // 'issue' | 'pr' | 'task'
  repo: text('repo').notNull(),
  externalId: text('external_id').notNull().unique(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  state: text('state').notNull(), // 'open' | 'closed' | 'merged'
  body: text('body'),
  labels: text('labels'), // JSON array of strings
  dueDate: text('due_date'),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Gmail Actions ----
export const gmailActions = sqliteTable('gmail_actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  threadId: text('thread_id').notNull().unique(),
  subject: text('subject').notNull(),
  fromAddress: text('from_address').notNull(),
  actionSummary: text('action_summary'),
  snippet: text('snippet'),
  receivedAt: integer('received_at', { mode: 'timestamp_ms' }),
  snoozedUntil: text('snoozed_until'),
  done: integer('done', { mode: 'boolean' }).default(false),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Drive Files ----
export const driveFiles = sqliteTable('drive_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(),
  name: text('name').notNull(),
  mimeType: text('mime_type'),
  url: text('url'),
  summary: text('summary'),
  lastModified: integer('last_modified', { mode: 'timestamp_ms' }),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Knowledge Files Index ----
export const knowledgeFiles = sqliteTable('knowledge_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(), // relative to knowledge-base/
  title: text('title').notNull(),
  category: text('category'), // 'profile' | 'work' | 'calendar' | 'inbox' | 'drive'
  lastModified: integer('last_modified', { mode: 'timestamp_ms' }),
  wordCount: integer('word_count').default(0),
  autoUpdated: integer('auto_updated', { mode: 'boolean' }).default(false)
})

// ---- App Settings ----
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Finance ----
export const financeAccounts = sqliteTable('finance_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(), // "Chase Sapphire", "BofA Checking"
  type: text('type').notNull().default('credit'), // 'checking' | 'savings' | 'credit' | 'investment'
  isDebt: integer('is_debt', { mode: 'boolean' }).default(false),
  balance: real('balance').default(0), // current balance; for debt accounts, positive = amount owed
  apr: real('apr').default(0), // annual rate as decimal e.g. 0.2499
  minPayment: real('min_payment').default(0),
  creditLimit: real('credit_limit'),
  institution: text('institution').notNull().default(''),
  // Net-worth bucket (Phase 4.4). 'spending' | 'savings' | 'retirement' |
  // 'real_estate' | 'manual_asset' | 'liability'. Drives which accounts
  // contribute to the assets side of the net-worth snapshot. `manual_asset`
  // accounts have no transaction stream — balance is only updated by the
  // user via finance:set-account-balance.
  assetClass: text('asset_class').notNull().default('spending'),
  // ISO 'YYYY-MM-DD'. Surfaced as a "Payments Due" reminder on the Dashboard
  // when within the next 14 days. Populated from PDF statement metadata.
  paymentDueDate: text('payment_due_date'),
  // Wall-clock ms of the last successful statement-metadata auto-update. Used
  // by Finance UI to show "synced X days ago" — auto-update gating is value-
  // based (only writes when the existing column is null/0), not timestamp-
  // based.
  lastStatementSyncedAt: integer('last_statement_synced_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Net worth balance snapshots (Phase 4.4) ----
// One row per (account, day) recording the inferred or manually-entered
// balance. Used by the net-worth dashboard for trajectory + delta queries.
export const financeBalanceSnapshots = sqliteTable('finance_balance_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id')
    .notNull()
    .references(() => financeAccounts.id),
  capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
  balance: real('balance').notNull(),
  source: text('source').notNull() // 'manual' | 'inferred' | 'plaid'
})

export const financeTransactions = sqliteTable('finance_transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  hash: text('hash').notNull().unique(), // dedup key
  date: text('date').notNull(), // ISO 'YYYY-MM-DD'
  amount: real('amount').notNull(), // negative = expense
  description: text('description').notNull(),
  accountId: integer('account_id').references(() => financeAccounts.id),
  category: text('category').default('Uncategorized'),
  subcategory: text('subcategory'),
  notes: text('notes'),
  // Geo + purpose are first-class indexed columns (promoted from notes tokens in 4.2).
  // 'CR' | 'US' | 'SPAIN' | 'COLOMBIA' | 'PANAMA' | 'OTHER'. Default 'US'.
  geo: text('geo').notNull().default('US'),
  // Only set for CR transactions: 'capex' | 'household' | 'operating' | 'travel' | 'other'.
  purpose: text('purpose'),
  // Tax disposition (Phase 4.3). 'tax:capex-airbnb' | 'tax:schedule-c-income' |
  // 'tax:schedule-c-expense' | 'tax:schedule-e-income' | 'tax:schedule-e-expense' |
  // 'tax:charitable' | 'tax:medical' | 'tax:home-office' | 'tax:personal' |
  // 'tax:investment' | 'tax:none'. Indexed with taxYear for year-end aggregation.
  taxTag: text('tax_tag').notNull().default('tax:none'),
  // 'auto' (set by classifier at ingest) or 'user' (manual override — never overwritten).
  taxTagSource: text('tax_tag_source').notNull().default('auto'),
  // Derived from `date` (year only) so year-end queries can use the index.
  taxYear: integer('tax_year'),
  sourceFile: text('source_file'),
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const budgetRules = sqliteTable('budget_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull(),
  subcategory: text('subcategory'),
  monthlyAmount: real('monthly_amount').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const categorizationRules = sqliteTable('categorization_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull(), // case-insensitive substring match
  category: text('category').notNull(),
  subcategory: text('subcategory'),
  priority: integer('priority').default(0)
})

// ---- Habits ----
export const habits = sqliteTable('habits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  icon: text('icon'),
  color: text('color').default('#6272f1'),
  active: integer('active', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const habitEntries = sqliteTable('habit_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  habitId: integer('habit_id').references(() => habits.id),
  date: text('date').notNull(), // ISO date 'YYYY-MM-DD'
  completed: integer('completed', { mode: 'boolean' }).default(false)
})

// ---- Knowledge Suggestions ----
export const knowledgeSuggestions = sqliteTable('knowledge_suggestions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  proposedAt: integer('proposed_at', { mode: 'timestamp_ms' }).notNull(),
  source: text('source').notNull(), // 'gmail' | 'github' | 'calendar'
  sourceId: text('source_id'), // optional ID back to the source row
  targetPath: text('target_path').notNull(), // 'profile/relationships.md' or 'work/employers.md'
  kind: text('kind').notNull(), // 'contact' | 'employer' | 'date' | 'note'
  proposedContent: text('proposed_content').notNull(), // a markdown snippet to insert
  context: text('context'), // why we proposed it (e.g., "appeared 3x in inbox")
  status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'dismissed'
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' })
})
