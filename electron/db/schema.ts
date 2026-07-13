import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

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
  // Storehouse projection inputs (Phase 10 live-sync). `author` = the opener login
  // (issue.user.login) → People; `updatedAt` = the item's own last-updated ISO time,
  // used as the timeline date (no created/updated column existed before).
  author: text('author'),
  updatedAt: text('updated_at'),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Linear issues (Phase 7 Track B) ----
// Issues assigned to the user, surfaced alongside GitHub on the dashboard.
// Separate table (not github_items) so the two sources stay semantically
// distinct and queryable on their own.
export const linearIssues = sqliteTable('linear_issues', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(), // Linear issue UUID
  identifier: text('identifier').notNull(), // human key, e.g. 'ENG-123'
  title: text('title').notNull(),
  url: text('url').notNull(),
  state: text('state').notNull(), // workflow state name, e.g. 'In Progress'
  stateType: text('state_type').notNull(), // 'backlog'|'unstarted'|'started'|'completed'|'canceled'|'triage'
  priority: integer('priority').notNull().default(0), // 0 none … 1 urgent … 4 low (Linear's scale)
  team: text('team'), // team key, e.g. 'ENG'
  dueDate: text('due_date'),
  // The issue's own last-updated ISO time — the Storehouse timeline date (Phase 10).
  updatedAt: text('updated_at'),
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

// ---- Insight lifecycle (Phase 7 Track E follow-up) ----
// One row per insight the detectors have EVER surfaced, keyed by a stable
// per-insight key. Gives "Worth a look" a memory: first-seen (for "new"
// badges), dismissed (stop nagging), pinned (keep on top). Detectors stay
// pure — this log is written only by the insights:list lifecycle layer.
export const insightLog = sqliteTable('insight_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  kind: text('kind').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  route: text('route').notNull(),
  firstSeen: integer('first_seen', { mode: 'timestamp_ms' }).notNull(),
  lastSeen: integer('last_seen', { mode: 'timestamp_ms' }).notNull(),
  dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false)
})

// ---- Finance ----
export const financeAccounts = sqliteTable('finance_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(), // "Chase Sapphire", "BofA Checking"
  type: text('type').notNull().default('credit'), // 'checking' | 'savings' | 'credit' | 'investment'
  isDebt: integer('is_debt', { mode: 'boolean' }).default(false),
  balance: real('balance').default(0), // current balance; for debt accounts, positive = amount owed
  // ISO 4217 native currency of this account (Phase 11.1). Balances + this
  // account's transactions are denominated here; net-worth/forecast convert to
  // the user's base currency via the `fx_rates` snapshot. Default 'USD' so every
  // pre-multi-currency account keeps working unchanged.
  currency: text('currency').notNull().default('USD'),
  // Foreign financial account flag (Phase 11.2). Drives the FBAR/FATCA
  // aggregation (a US person's foreign bank/securities accounts). Defaults false;
  // backfilled to true for non-USD accounts as a sensible starting guess the user
  // can correct (a USD-denominated account at a foreign bank is still foreign).
  isForeign: integer('is_foreign', { mode: 'boolean' }).notNull().default(false),
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
  // Day of month the user pays this account's debt minimum (1-28). Used by
  // the cash-flow forecast (Phase 4.5) to schedule debt outflows. Default
  // null = "no fixed pay day, fall back to paymentDueDate".
  paymentDayOfMonth: integer('payment_day_of_month'),
  // Plaid linkage (Phase 4.6). When set, this account is owned by a Plaid
  // Item — its balance is refreshed by the Plaid sync loop instead of by
  // CSV ingest, and the user-facing Accounts UI marks it as linked.
  // Nullable so manually-created accounts and CSV-only accounts coexist.
  plaidItemId: integer('plaid_item_id').references((): AnySQLiteColumn => plaidItems.id),
  // Plaid's per-Item unique account id (returned from /accounts/get).
  // Used as the JOIN key when normalizing /transactions/sync output.
  plaidAccountId: text('plaid_account_id'),
  // Last 4 digits of the account number — Plaid returns this as `mask`.
  // Surfaced in the Accounts UI badge; intentionally never the full number.
  mask: text('mask'),
  // SimpleFIN linkage (Phase 4.7). When set, this account is owned by a
  // SimpleFIN connection — its balance is refreshed by the SimpleFIN sync
  // loop instead of by CSV ingest. Mirrors the Plaid linkage above and is
  // independent of it: an account belongs to at most one provider. Both
  // nullable so manual / CSV / Plaid / SimpleFIN accounts all coexist.
  simplefinConnectionId: integer('simplefin_connection_id').references(
    (): AnySQLiteColumn => simplefinConnections.id
  ),
  // SimpleFIN's per-connection unique account `id` (from GET /accounts).
  // Used as the JOIN key when normalizing transactions and as the upsert
  // key so a daily re-pull refreshes the same row instead of duplicating it.
  simplefinAccountId: text('simplefin_account_id'),
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
  source: text('source').notNull() // 'manual' | 'inferred' | 'live' — see SnapshotSource in finance-snapshot.ts
})

// ---- FX-rate snapshots (Phase 11.1 — multi-currency foundation) ----
// One row per (day, base→quote) exchange rate. `rate` is units of `quote` per
// ONE unit of `base` (e.g. base='USD', quote='CRC', rate=512.3 → $1 = ₡512.3).
// The latest row for a pair drives net-worth/forecast conversion to the user's
// base currency; historical rows let a transfer's FX gain/loss be computed at
// the rate that held on its day. Rows arrive from a manual entry OR a daily
// main-process fetch (Phase 11.1b) — `source` records which. Idempotent: the
// UNIQUE (date, base, quote) index upserts a re-fetch/re-entry in place.
export const fxRates = sqliteTable(
  'fx_rates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(), // ISO 'YYYY-MM-DD' — the rate's as-of day (local)
    base: text('base').notNull(), // ISO 4217, e.g. 'USD'
    quote: text('quote').notNull(), // ISO 4217, e.g. 'CRC'
    rate: real('rate').notNull(), // units of `quote` per 1 unit of `base`
    source: text('source').notNull().default('manual'), // 'manual' | 'erapi'
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
  },
  (t) => ({
    uniqByDayPair: uniqueIndex('uq_fx_rates_date_base_quote').on(t.date, t.base, t.quote)
  })
)

// ---- Forecast overrides (Phase 4.5) ----
// User edits to the projected cash-flow stream. The forecast engine reads
// these to skip / shift / replace the auto-generated event for a given
// account+date. `kind='shift'` populates `shiftToDate`; `kind='override'`
// populates `amount`; `kind='skip'` needs neither.
export const forecastOverrides = sqliteTable('forecast_overrides', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id')
    .notNull()
    .references(() => financeAccounts.id),
  date: text('date').notNull(), // ISO 'YYYY-MM-DD' — date of the auto event being overridden
  amount: real('amount'), // null unless kind='override'
  label: text('label'),
  kind: text('kind').notNull(), // 'skip' | 'shift' | 'override'
  shiftToDate: text('shift_to_date'), // populated when kind='shift'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Plaid items (Phase 4.6) ----
// One row per connected institution (Item in Plaid's vocabulary). The
// access_token for each Item is encrypted via safeStorage and stored in
// .vault/plaid.enc — NEVER in SQLite. The columns here are non-secret
// metadata that the sync loop and UI need to surface.
export const plaidItems = sqliteTable('plaid_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Plaid's stable item_id (returned from /item/public_token/exchange).
  // Used as the natural key — UNIQUE so a re-connect updates the existing
  // row rather than creating a duplicate.
  itemId: text('item_id').notNull().unique(),
  // Plaid's institution_id (e.g. `ins_3` for Chase). Stable across Plaid
  // environments.
  institutionId: text('institution_id').notNull(),
  // Human-readable institution name (e.g. "Chase"). Shown in the
  // Integrations card and Accounts badge.
  institutionName: text('institution_name').notNull(),
  // Cursor for /transactions/sync pagination. Null on first sync; updated
  // after each successful pull. Plaid guarantees idempotency keyed by this
  // cursor, so we can crash mid-sync and resume without dupes.
  cursor: text('cursor'),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
  // Plaid error code (e.g. `ITEM_LOGIN_REQUIRED`). When non-null, the
  // Integrations card surfaces a "re-authenticate" CTA.
  errorCode: text('error_code'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- SimpleFIN connections (Phase 4.7) ----
// One row per claimed SimpleFIN Bridge Setup Token. SimpleFIN has no
// "item_id" — a single Access URL can front many orgs/accounts — so we mint
// our own stable `connectionId` (randomUUID) at claim time. The Access URL
// itself (which embeds HTTP Basic credentials) is encrypted in
// .vault/simplefin.enc keyed by `connectionId` — NEVER in SQLite. The columns
// here are non-secret metadata the sync loop and UI need.
//
// Deliberate divergence from `plaidItems`: NO `cursor` column. SimpleFIN is a
// date-windowed pull (GET /accounts?start-date=…), not a cursor-paginated
// delta. Idempotency comes entirely from the `hash` UNIQUE constraint on
// finance_transactions — re-pulling the same window inserts nothing new.
export const simplefinConnections = sqliteTable('simplefin_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Locally-minted stable key (randomUUID). UNIQUE so a re-claim updates the
  // existing row rather than creating a duplicate.
  connectionId: text('connection_id').notNull().unique(),
  // org.name from the first account's `org` block (e.g. "American Express").
  // Display only; used to build the `sourceFile` token.
  orgName: text('org_name').notNull().default(''),
  // org.domain (e.g. "americanexpress.com"). Optional; display only.
  orgDomain: text('org_domain'),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
  // Last error surfaced by SimpleFIN (a non-empty `errors[]` entry) or a fetch
  // failure (e.g. 403 after the user revoked the Access URL). When non-null,
  // the Integrations card prompts the user to re-claim a fresh Setup Token.
  errorCode: text('error_code'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const financeTransactions = sqliteTable('finance_transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  hash: text('hash').notNull().unique(), // dedup key
  date: text('date').notNull(), // ISO 'YYYY-MM-DD'
  amount: real('amount').notNull(), // negative = expense
  // ISO 4217 currency this `amount` is denominated in (Phase 11.1). Inherited
  // from the owning account at ingest; default 'USD'. Lets a colón-priced CR
  // charge report its true base-currency (USD) cost via the `fx_rates` snapshot.
  currency: text('currency').notNull().default('USD'),
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
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  // Cross-domain leverage (2026-07-03): opt a habit into auto-fill from a life-logging
  // source. `autoLinkSource` is a source-prefixed metric key (e.g. 'oura-sleep-score',
  // 'oura-readiness-score', 'oura-steps') so multiple wearables can share the same
  // habits table without key collisions. Both null = manual habit (the default).
  autoLinkSource: text('auto_link_source'),
  autoLinkThreshold: real('auto_link_threshold')
})

export const habitEntries = sqliteTable('habit_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  habitId: integer('habit_id').references(() => habits.id),
  date: text('date').notNull(), // ISO date 'YYYY-MM-DD'
  completed: integer('completed', { mode: 'boolean' }).default(false),
  // 'oura' (etc.) when auto-filled by a sync; null = user-toggled via `habits:toggle`.
  // The "pre-populated but user-editable" trust model: a manual toggle clears this
  // back to null, so future auto-fill runs never re-overwrite a user's own edit.
  source: text('source')
})

// ---- Records / Timeline (Phase 10 — "The Acquisition Engine", Wave 10.1) ----
// One append-only, polymorphic event log. Anything the Drop Zone ingests from a
// data export (Netflix history, Spotify history, any dated CSV/JSON) lands here as
// a typed event on a unified timeline. `payload` keeps the full original row as
// JSON (the same JSON-in-text idiom as contacts/githubItems); `dedupHash` is the
// content-addressed UNIQUE key (mirrors `financeTransactions.hash`) so re-importing
// the same export upserts in place instead of duplicating. Typed projections come
// later; for now everything is queried straight off this table.
export const records = sqliteTable('records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // recognizer id: 'netflix' | 'spotify' | 'generic'
  type: text('type').notNull(), // event kind: 'watch' | 'listen' | 'event'
  occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }), // when it happened (nullable)
  title: text('title').notNull(), // timeline display string
  body: text('body'), // optional secondary line (e.g. "23 min")
  payload: text('payload'), // full original row as JSON
  dedupHash: text('dedup_hash').notNull().unique(), // content-addressed dedup key
  provenance: text('provenance'), // import filename / batch
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Documents & files store (Phase 9.2 "Storehouse") ----
// A real documents domain: import a file, keep the original on disk under
// DOCUMENTS_DIR, extract PDF text into `documents_fts` so it's searchable, and
// attach the doc to any record/entity via `document_links`. Content stays
// on-device plaintext (matches how imported records store content) — the vault
// remains the home for anything that must be encrypted.
export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(), // display name (defaults to the filename stem)
  fileName: text('file_name').notNull(), // original filename as imported
  mimeType: text('mime_type'), // detected MIME (allowlisted at import)
  byteSize: integer('byte_size'),
  sha256: text('sha256').notNull().unique(), // content hash → dedup key + stored filename base
  storedPath: text('stored_path').notNull(), // RELATIVE to DOCUMENTS_DIR (never absolute / user path)
  extractedText: text('extracted_text'), // PDF text for FTS; null for non-PDF
  pageCount: integer('page_count'),
  docDate: text('doc_date'), // ISO 'YYYY-MM-DD'; null = unknown
  category: text('category'),
  notes: text('notes'),
  source: text('source').notNull().default('manual'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// A document can attach to many targets (a records-spine row or a derived
// entity) — a join table keeps that many-to-many clean.
export const documentLinks = sqliteTable(
  'document_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: integer('document_id')
      .notNull()
      .references(() => documents.id),
    // 'record' | 'contact' | 'merchant' | 'place' | 'asset' | 'subscription'
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(), // record id (as string) or entity external id
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
  },
  (t) => ({
    linkUnique: uniqueIndex('document_links_doc_target').on(t.documentId, t.targetKind, t.targetId)
  })
)

// Static, NON-timeline snapshot facts from a data export — the parts of an archive
// that describe *who you are / what's set* rather than *what happened*: your ad-
// interest profile, the apps sharing data off-Meta, profile identity fields, account
// security config. Grouped by (source, category); each themed page reads one
// category. Re-import is idempotent via the UNIQUE `dedup_hash`.
export const snapshotFacts = sqliteTable('snapshot_facts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // 'facebook'
  category: text('category').notNull(), // themed page: 'ad-profile' | 'profile' (more: off-meta-apps, security)
  label: text('label'), // optional key (e.g. "Email", an app name); null for bare list items
  value: text('value').notNull(), // the fact value / list item
  position: integer('position').notNull().default(0), // stable order within (source, category)
  dedupHash: text('dedup_hash').notNull().unique(),
  provenance: text('provenance'), // import filename
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
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

// ---- Claude Proposals (Claude Inbox — Phase 8.2) ----
// Confirmed-writes queue: the read-only MCP appends proposals to
// `.data/claude-inbox.jsonl`; the app ingests them here (dedup by
// `proposalId`) and the user approves/rejects each one. On approve the change
// is applied via the app's validated write paths; nothing mutates user data
// until then. See electron/ipc/claude.ts + docs/claude-integration.md.
export const claudeProposals = sqliteTable('claude_proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  proposalId: text('proposal_id').notNull().unique(), // UUID minted by the MCP — dedup key
  type: text('type').notNull(), // 'task' | 'note' | 'txn_tag' | 'habit_check'
  payload: text('payload').notNull(), // JSON string of the type-specific payload
  source: text('source').notNull().default('claude-mcp'),
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected' | 'failed'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(), // when the MCP minted it
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }), // approve/reject/fail time
  error: text('error'), // failure detail when status = 'failed'
  resultRef: text('result_ref'), // e.g. created checklist id / note path
  // Soft-clear: "clear resolved" hides rows from the inbox but KEEPS them so the
  // append-only JSONL (never truncated) can't re-ingest + re-apply a resolved
  // proposal as a fresh pending one. Dedup is by `proposalId`, so the row must
  // survive a clear.
  clearedAt: integer('cleared_at', { mode: 'timestamp_ms' })
})

// ---- Contacts (Phase 9 — "The Storehouse", Wave 1) ----
// The structured people/address-book store. Before this, contacts existed only
// as freeform markdown in `knowledge-base/profile/relationships.md`. This table
// is the canonical home: queryable (LIKE over `searchBlob`), cross-linkable to
// calendar attendees + email senders, and round-trippable to vCard/CSV via
// `electron/lib/vcard.ts` + `electron/lib/csv.ts`.
//
// Multi-valued fields (phones/emails/addresses) are JSON-encoded in text columns
// — the same idiom as `githubItems.labels` / `integrations.scopes`. A normalized
// child table exists nowhere else in this codebase, and one VCARD block maps to
// one row, so JSON keeps the model flat without losing vCard fidelity.
export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // vCard UID / source-native id / minted uuid. UNIQUE so re-importing the same
  // export upserts in place instead of duplicating.
  externalId: text('external_id').notNull().unique(),
  displayName: text('display_name').notNull(), // vCard FN
  // vCard N components, kept separate for round-trip fidelity.
  givenName: text('given_name'),
  familyName: text('family_name'),
  middleName: text('middle_name'),
  prefix: text('prefix'),
  suffix: text('suffix'),
  org: text('org'), // vCard ORG
  jobTitle: text('job_title'), // vCard TITLE
  // JSON arrays. phones: [{ type, value, pref? }]; emails: [{ type, value, pref? }];
  // addresses: [{ type, street, city, region, postalCode, country, pref? }].
  phones: text('phones'),
  emails: text('emails'),
  addresses: text('addresses'),
  birthday: text('birthday'), // ISO 'YYYY-MM-DD' (text — matches finance/habits date idiom)
  url: text('url'),
  relationship: text('relationship'), // 'friend' | 'family' | 'colleague' | ... (free text)
  notes: text('notes'),
  // vCard PHOTO as a data URI. Size-capped at import. NEVER selected in list
  // queries (only in contacts:get) so the list payload stays light.
  photo: text('photo'),
  // 'manual' | 'vcard' | 'csv' | 'macos' | 'google' | 'linkedin' | 'facebook' | 'gvoice'
  source: text('source').notNull().default('manual'),
  // Lowercased name + org + emails + phones (+ enrichment nicknames), recomputed
  // on every write. Powers the LIKE search in contacts:list without a join.
  searchBlob: text('search_blob'),
  // JSON `ContactEnrichment` (electron/lib/contact-enrichment.ts): two namespaces
  // — `google` (rich People API fields with no dedicated column) + `crossSource`
  // (how the user knows this person across every connected source). NEVER
  // selected in list queries (only in contacts:get), like `photo`, so the list
  // payload stays light.
  enrichment: text('enrichment'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Subscriptions (Phase 9.3 — "The Storehouse") ----
// First-class, user-OWNED subscription records. Distinct from the *derived*
// `auditSubscriptions()` detector (electron/integrations/finance-subscriptions.ts),
// which infers recurring charges from the transaction ledger and stays untouched
// (the morning-brief price-hike alert depends on it). This table is what the user
// curates: subscriptions Compass can't see (cash/annual/another card), edits to
// detected ones (true cost, renewal date, cancel URL), and a place to mark things
// cancelled. Detected rows can be "tracked" into here; `externalId` dedupes
// (`detected:<merchant>::<account>` for materialized rows, `manual:<uuid>` else).
export const subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(),
  name: text('name').notNull(),
  cost: real('cost').notNull().default(0), // per-cadence amount (positive)
  cadence: text('cadence').notNull().default('monthly'), // weekly|biweekly|monthly|quarterly|semi-annual|yearly
  category: text('category'),
  status: text('status').notNull().default('active'), // active|paused|cancelled
  nextRenewal: text('next_renewal'), // ISO 'YYYY-MM-DD'
  paymentAccount: text('payment_account'),
  cancelUrl: text('cancel_url'),
  notes: text('notes'),
  source: text('source').notNull().default('manual'), // 'manual' | 'detected'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Household & Assets (Phase 9.5 — "The Storehouse") ----
// The things you OWN and the policies/memberships around them: houses & other
// property and their value, vehicles, insurance, memberships, warranties, pets.
// One flat table with a `type` discriminator (same pragmatic approach as the
// vault's category list) keeps the model simple while covering the spread.
// `reference` holds NON-secret identifiers (policy #, VIN, membership #);
// anything truly sensitive stays in the encrypted vault. `renewalDate` powers
// "renews/expires soon" surfacing.
export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(), // 'manual:<uuid>'
  // 'insurance' | 'vehicle' | 'property' | 'membership' | 'warranty' | 'pet' | 'other'
  type: text('type').notNull().default('other'),
  name: text('name').notNull(),
  value: real('value'), // current worth / coverage amount (nullable)
  provider: text('provider'), // insurer / dealer / club / manufacturer
  reference: text('reference'), // policy # / VIN / membership # — NON-secret
  renewalDate: text('renewal_date'), // ISO 'YYYY-MM-DD' — renewal / expiry
  status: text('status').notNull().default('active'), // active | expired | sold | cancelled
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Life records (the vault split — 2026-07) ----
// The METADATA half of what used to live in the encrypted vault's document
// categories (financial / identity / medical / legal / foreign-accounts):
// institutions, document types, parties, dates, notes — plaintext, searchable,
// timeline-projected, and readable by every surface including the MCP server,
// per docs/data-access-policy.md. The SECRET field values (account/routing
// numbers, SSN/passport/DL numbers, insurance member/group ids) never touch
// this table: they live in the standalone encrypted `.vault/record-secrets.enc`
// blob, keyed by this table's row id (see electron/ipc/life-records.ts).
// One flat table with a `category` discriminator + schemaless `fields` JSON —
// the same pragmatic shape as `assets` and the vault's own category templates.
export const lifeRecords = sqliteTable('life_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 'vault:<oldEntryId>' (migrated) | 'manual:<uuid>' | 'detected:<uuid>' | '1password:<uuid>'
  externalId: text('external_id').notNull().unique(),
  // 'financial' | 'identity' | 'medical' | 'legal' | 'foreign-accounts'
  category: text('category').notNull(),
  title: text('title').notNull(), // derived display label (institution / documentType / provider …)
  fields: text('fields'), // JSON Record<string,string> — NON-secret template fields only
  notes: text('notes'),
  // Lock badge without decrypting: does record-secrets.enc hold values for this row?
  hasSecrets: integer('has_secrets', { mode: 'boolean' }).notNull().default(false),
  source: text('source').notNull().default('manual'), // 'manual' | 'vault-migration' | 'detected' | '1password'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Derived entities (cross-reference engine) ----
// A CACHE, not user data: the people / merchants / places / subscription
// candidates the engine (`electron/lib/entities.ts`) derives from the `records`
// timeline, refreshed after every import (like the records semantic index).
// Fully recomputable from `records` + owned tables, so it carries no authority —
// the source of truth for "is this promoted" stays the owned row's `externalId`.
// `promotedId`/`promotedKind` are denormalized convenience, recomputed each refresh.
export const derivedEntities = sqliteTable(
  'derived_entities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(), // 'person' | 'merchant' | 'place' | 'subscription-candidate'
    matchKey: text('match_key').notNull(), // normalized key, unique within a kind
    name: text('name').notNull(), // canonical display
    count: integer('count').notNull().default(0), // total record touchpoints
    sources: text('sources').notNull().default('[]'), // JSON string[]
    firstSeen: integer('first_seen', { mode: 'timestamp_ms' }),
    lastSeen: integer('last_seen', { mode: 'timestamp_ms' }),
    attrs: text('attrs'), // JSON EntityAttrs (spend, cadence, …)
    promotedKind: text('promoted_kind'), // 'contact' | 'subscription' | 'place' | null
    promotedId: integer('promoted_id'), // owned-row id when promoted/matched
    refreshedAt: integer('refreshed_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
  },
  (t) => ({
    kindKeyUnique: uniqueIndex('derived_entities_kind_key').on(t.kind, t.matchKey),
    kindCountIdx: index('derived_entities_kind_count').on(t.kind, t.count)
  })
)

// ---- Places & merchants (cross-reference engine — promote target) ----
// The OWNED home for a merchant/place the user promotes out of `derived_entities`:
// the businesses they transact with and the places they go. Mirrors the `assets`
// shape (flat, `kind` discriminator). `external_id` UNIQUE (`derived:<kind>:<key>`
// for a promoted entity / `manual:<uuid>`) dedupes a re-promote. `reference`-free —
// nothing sensitive; `total_spend` is the rolled-up spend at promote time.
export const places = sqliteTable('places', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(),
  kind: text('kind').notNull().default('merchant'), // 'merchant' | 'place'
  name: text('name').notNull(),
  category: text('category'),
  address: text('address'),
  url: text('url'),
  totalSpend: real('total_spend'),
  notes: text('notes'),
  source: text('source').notNull().default('manual'), // 'manual' | 'derived'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Travel segments (Phase 11.5 — days-in-country & residency) ----
// One row per trip the user logs OUTSIDE their home country: a country + an
// inclusive [startDate, endDate] window. Per-country day counts (the rest of the
// year defaults to the home country) feed the US substantial-presence test and a
// CR 183-day residency check. `source` allows a future calendar/I-94 auto-fill;
// for now everything is `manual`. Dates are date-only ISO strings (local day),
// matching the finance/habits idiom.
export const travelSegments = sqliteTable('travel_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  country: text('country').notNull(), // ISO-3166 alpha-2 (e.g. 'CR', 'US', 'ES')
  startDate: text('start_date').notNull(), // ISO 'YYYY-MM-DD' (inclusive)
  endDate: text('end_date').notNull(), // ISO 'YYYY-MM-DD' (inclusive)
  notes: text('notes'),
  source: text('source').notNull().default('manual'), // 'manual' | 'calendar' | 'i94' | 'location'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Location points (Phase 10.8 — "Location → Residency autopilot") ----
// Raw GPS points from a location-history export (OwnTracks / GPX / Google Location
// History). DELIBERATELY its own table, NOT the `records` timeline spine: this is
// the ONE exclusion in the data-access policy (docs/data-access-policy.md). The
// assistant/MCP timeline search (`searchRecords` / `compass_search_timeline`) has
// no per-source denylist, so keeping coordinates out of `records` IS the wall.
// The derived, coarse `travel_segments` (country + date window) DO project onto
// the spine. Re-import is idempotent via the UNIQUE `dedup_hash` (same
// content-addressed idiom as `records`/`finance_transactions`).
export const locationPoints = sqliteTable('location_points', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(), // when the point was recorded
  lat: real('lat').notNull(),
  lng: real('lng').notNull(),
  accuracy: real('accuracy'), // meters, when the export provides it
  src: text('src').notNull(), // 'owntracks' | 'gpx' | 'google'
  dedupHash: text('dedup_hash').notNull().unique(), // content-addressed dedup key
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Argyle paystubs (Phase 10.9 — "Argyle → forecast") ----
// Real payroll paystubs from the Argyle aggregator, feeding the cash-flow
// forecast (ground-truth income cadence + net pay, replacing bank-deposit
// inference) and an income summary. Projects onto the `records` spine
// (`source:'paystub'`) per the data-access policy — full-detail searchable.
// Only summed withholding / deductions are kept — never the per-tax breakdown
// (that detail is stripped at ingest and never stored). Amounts are numeric in
// the paystub's own `currency`; dates are local-day 'YYYY-MM-DD' strings.
export const argylePaystubs = sqliteTable('argyle_paystubs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(), // Argyle paystub id (dedup key)
  employer: text('employer'),
  grossPay: real('gross_pay'),
  netPay: real('net_pay'), // what actually lands in the bank — the cash-forecast inflow
  withholding: real('withholding'), // Σ taxes (for the effective-rate summary; no per-line detail)
  deductions: real('deductions'), // Σ non-tax deductions (401k, benefits…)
  currency: text('currency').notNull().default('USD'),
  periodStart: text('period_start'), // 'YYYY-MM-DD'
  periodEnd: text('period_end'),
  paidAt: text('paid_at'), // 'YYYY-MM-DD' — the deposit date the forecast keys on
  payCycle: text('pay_cycle'), // raw Argyle frequency hint if provided ('weekly'|'biweekly'|…)
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Utility bills (Phase 10.9 — "Arcadia → property P&L") ----
// Utility statements from the Arcadia aggregator, surfaced on the Schedule-E property P&L
// (`finance-property.ts`) — always informationally, and as the utilities operating-expense
// line only when the user opts in (`propertyIncludeUtilityBills`). Projects onto the
// `records` spine (`source:'utility'`) per the data-access policy. Statements stay OUT of
// `finance_transactions` (the cash ledger) so nothing double-counts vs the bank payment —
// spend math reads finance_transactions only. Holds `usage_kwh` for future carbon
// leverage. Amounts are positive (bill totals) in the statement's own `currency`; dates
// are local-day 'YYYY-MM-DD'.
export const utilityBills = sqliteTable('utility_bills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(), // Arcadia statement id (dedup key)
  provider: text('provider'), // utility company
  serviceAddress: text('service_address'), // matched against the property config to attribute the bill
  statementDate: text('statement_date'), // 'YYYY-MM-DD' — the expense date the P&L buckets by year
  periodStart: text('period_start'),
  periodEnd: text('period_end'),
  amount: real('amount'), // bill total (positive)
  currency: text('currency').notNull().default('USD'),
  usageKwh: real('usage_kwh'), // energy usage when provided (future carbon leverage)
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Medical records (Phase 10.9 — "Metriport → medical records") ----
// Clinical records pulled from the health-information networks via Metriport (FHIR R4):
// conditions, medications, labs, immunizations, allergies, encounters. Projects onto the
// `records` spine (`source:'medical'`) per the data-access policy — full-detail searchable
// and AI-readable; the on-this-day sensitivity guard (timeline-memories.ts) keeps medical
// from ever auto-resurfacing unprompted. Stores the clinical SUMMARY (category + display
// name + status + date), never raw values, patient identifiers, MRN/SSN, or provider
// contact info — that detail is stripped at ingest and never stored. `category` is one of
// 'condition'|'medication'|'lab'|'immunization'|'allergy'|'encounter'|'procedure'.
export const medicalRecords = sqliteTable('medical_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  externalId: text('external_id').notNull().unique(), // 'metriport:<ResourceType>:<id>' (dedup key)
  category: text('category').notNull(),
  description: text('description'), // the clinical name/text (Aspirin, Type 2 diabetes, Influenza…)
  code: text('code'), // the coding code (ICD-10 / RxNorm / LOINC / CVX), when present
  status: text('status'), // active | resolved | completed | …
  recordedAt: text('recorded_at'), // 'YYYY-MM-DD' — onset/effective/recorded date
  ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Lab results (manually imported quantitative lab/vital values) ----
// `medicalRecords` (above) is deliberately summary-only — no raw values, by design,
// because it mirrors Metriport's stripped-at-ingest FHIR feed. This table is the
// counterpart for hand/document-imported results where the NUMBER is the point:
// cholesterol panels, CBC/chem panels, troponin, vitals. One row per individual
// test so trends are queryable; `panel` groups tests drawn together (e.g.
// 'Coronary Risk Profile', 'CBC Panel Auto'), `encounterId` groups panels from the
// same visit/lab order. Per the data-access policy this is full-detail readable,
// same posture as `medicalRecords` — not vault-sealed.
export const labResults = sqliteTable(
  'lab_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    testName: text('test_name').notNull(),
    panel: text('panel'),
    value: real('value'), // numeric result, when the result is a number
    valueText: text('value_text'), // fallback display for non-numeric results
    unit: text('unit'),
    refRange: text('ref_range'), // as printed/reported, e.g. '<200 mg/dL' or '3.5-5.5 mmol/L'
    flag: text('flag'), // 'normal' | 'low' | 'high' | 'critical-low' | 'critical-high'
    takenAt: text('taken_at').notNull(), // 'YYYY-MM-DD' — specimen collected date
    encounterId: text('encounter_id'), // groups results from the same visit/lab order
    source: text('source').notNull().default('manual'), // 'manual' | 'document-import'
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
  },
  (t) => ({
    testNameTakenAtIdx: index('lab_results_test_name_taken_at').on(t.testName, t.takenAt)
  })
)

// ---- Timeline memory mutes (Timeline 2.0 PR 6) ----
// "Never resurface this" — the memory layer's safety valve (breakups, losses,
// anything the user doesn't want the On-this-day hero echoing back). Reversible
// tags, not deletion: the records stay on disk and in browse/search; mutes only
// filter RESURFACING (on-this-day / anniversaries). `kind` scopes the target:
// 'record' (target = record id), 'source-type' (target = 'source|type').
export const timelineMutes = sqliteTable(
  'timeline_mutes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(), // 'record' | 'source-type'
    target: text('target').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
  },
  (t) => ({
    kindTargetUnique: uniqueIndex('timeline_mutes_kind_target').on(t.kind, t.target)
  })
)

// ---- Curation exclusions (contacts & entities curation) ----
// The user's durable "no" list — the memory that makes deletions/dismissals STICK
// across syncs and cache rebuilds (same shape as timeline_mutes). `kind` scopes
// the target:
//   'contact-tombstone'  target = contacts.external_id — user deleted it; no sync
//                        or import may ever re-create it (Settings can clear).
//   'contact-merged'     target = a dedupe loser's external_id — folded into a
//                        survivor; kept SEPARATE from tombstones so clearing
//                        blocked contacts can't resurrect merge losers as dupes.
//   'entity:person' | 'entity:merchant' | 'entity:place'
//                        target = derived_entities.match_key — "Not interested";
//                        filtered out of every refreshDerivedEntities rebuild.
//   'dedupe-dismissed'   target = JSON.stringify([extIdA, extIdB].sort()) — a
//                        rejected fuzzy-duplicate pair; never re-suggested.
//                        (JSON, not a joined string: external ids can contain '|'.)
export const curationExclusions = sqliteTable(
  'curation_exclusions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    target: text('target').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
  },
  (t) => ({
    kindTargetUnique: uniqueIndex('curation_exclusions_kind_target').on(t.kind, t.target)
  })
)

// ---- Financial goals (Phase 11.6 — "Goals & milestones") ----
// Target-date savings goals that tie the cross-border picture together: a tax
// reserve, the next CR capex draw, the retirement number, an emergency fund.
// `source` says how the CURRENT value is resolved — 'manual' (user-entered
// `manualCurrent`) or an auto-link to a live aggregate ('net-worth' /
// 'retirement' / 'property-basis') so a goal tracks itself. All amounts are in
// the user's base currency (Phase 11.1).
export const financialGoals = sqliteTable('financial_goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // Display/grouping only: 'tax-reserve' | 'capex' | 'retirement' | 'emergency' | 'savings' | 'other'
  category: text('category').notNull().default('other'),
  targetAmount: real('target_amount').notNull().default(0),
  targetDate: text('target_date'), // ISO 'YYYY-MM-DD'; null = open-ended
  // 'manual' | 'net-worth' | 'retirement' | 'property-basis'
  source: text('source').notNull().default('manual'),
  manualCurrent: real('manual_current').notNull().default(0), // current value when source='manual'
  monthlyContribution: real('monthly_contribution').notNull().default(0), // planned monthly savings
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// ---- Oura daily metrics (health-fitness — first LIVE source in this category) ----
// One row per calendar day, merged from Oura's three `daily_*` v2 endpoints
// (sleep/readiness/activity). `date` is the natural key — UNIQUE so a re-sync of
// the last-30-days window upserts in place instead of duplicating, mirroring the
// `hash`/`external_id` idempotency idiom used by finance/GitHub/Linear. All score
// fields are nullable because Oura may not have finished processing "today" yet
// (a day's data can lag until the ring syncs + Oura's own processing completes).
export const ouraDailyMetrics = sqliteTable('oura_daily_metrics', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(), // ISO 'YYYY-MM-DD'
  sleepScore: integer('sleep_score'), // 0-100
  readinessScore: integer('readiness_score'), // 0-100
  activityScore: integer('activity_score'), // 0-100
  steps: integer('steps'),
  totalSleepMinutes: integer('total_sleep_minutes'),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

// CR Rental Studio comps (Phase 10.2) — Airbnb-style listings the user collects to
// price their own unit. A growing, row-edited list → its own table (modeled on
// financial_goals). Units + studio settings are small/fixed and live as JSON in
// app_settings instead. Only nightly_usd + bedrooms feed the pricing engine; the
// rest is metadata for the comps-table UI.
export const rentalComps = sqliteTable('rental_comps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().default(''),
  url: text('url').notNull().default(''),
  zone: text('zone').notNull().default('Cartago'),
  bedrooms: integer('bedrooms').notNull().default(2),
  nightlyUsd: real('nightly_usd'),
  occupancyPct: real('occupancy_pct'),
  rating: real('rating'),
  reviewCount: integer('review_count'),
  notes: text('notes'),
  savedAt: text('saved_at'), // ISO 'YYYY-MM-DD' the comp was captured
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})
