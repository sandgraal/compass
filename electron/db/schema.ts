import {
  type AnySQLiteColumn,
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
  source: text('source').notNull() // 'manual' | 'inferred' | 'plaid'
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
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})

export const habitEntries = sqliteTable('habit_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  habitId: integer('habit_id').references(() => habits.id),
  date: text('date').notNull(), // ISO date 'YYYY-MM-DD'
  completed: integer('completed', { mode: 'boolean' }).default(false)
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
  // Lowercased name + org + emails + phones, recomputed on every write. Powers
  // the LIKE search in contacts:list without a join or a full-text index.
  searchBlob: text('search_blob'),
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
  source: text('source').notNull().default('manual'), // 'manual' | 'calendar' | 'i94'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date())
})
