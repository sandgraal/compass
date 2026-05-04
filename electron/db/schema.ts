import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

// ---- Integrations ----
export const integrations = sqliteTable('integrations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull().unique(), // 'google' | 'github'
  connectedAt: integer('connected_at', { mode: 'timestamp_ms' }),
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
  status: text('status').notNull().default('disconnected'), // 'connected' | 'disconnected' | 'error'
  scopes: text('scopes'), // JSON array
  errorMessage: text('error_message')
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
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())
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
