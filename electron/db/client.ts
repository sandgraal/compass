import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { backfillGeoFromNotes } from '../integrations/finance-geo'
import { backfillTaxTags } from '../integrations/finance-tax'
import { DATA_DIR } from '../paths'
import { reconcileMigrationState } from './reconcile'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle> | null = null
let _sqlite: Database.Database | null = null
const MIGRATIONS_FOLDER = join(__dirname, 'migrations')

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.')
  return _db as ReturnType<typeof drizzle<typeof schema>>
}

/**
 * Raw `better-sqlite3` connection. Used by helpers that compose multiple
 * statements via prepared queries (e.g. finance-snapshot.ts) where the
 * Drizzle wrapper would add overhead with no schema-typing benefit.
 */
export function getRawSqlite(): Database.Database {
  if (!_sqlite) throw new Error('DB not initialized. Call initDb() first.')
  return _sqlite
}

export async function initDb(): Promise<void> {
  const dbPath = join(DATA_DIR, 'compass.db')
  const sqlite = new Database(dbPath)

  // WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  _db = drizzle(sqlite, { schema })
  _sqlite = sqlite

  // Run migrations
  try {
    reconcileMigrationState(sqlite, MIGRATIONS_FOLDER)
    migrate(_db as ReturnType<typeof drizzle>, {
      migrationsFolder: MIGRATIONS_FOLDER
    })
  } catch {
    // Migrations folder may not exist yet; create schema directly on first run
    createTablesIfNeeded(sqlite)
  }
  // Always ensure new tables exist for existing DBs that pre-date migrations
  ensureNewTables(sqlite)
}

/**
 * Rebuild the `records_fts` full-text index from `records`. Use after the index
 * is added to a DB that already holds records, or to recover from any drift.
 * Exported for tests + manual recovery.
 */
export function rebuildRecordsFts(sqlite: Database.Database): void {
  sqlite.exec("INSERT INTO records_fts(records_fts) VALUES('rebuild')")
}

/**
 * Rebuild `records_fts` only when it's out of sync with `records` (cheap no-op
 * otherwise). Detection uses the FTS5 `_docsize` shadow table — one row per
 * INDEXED document — because `COUNT(*) FROM records_fts` reads the external
 * CONTENT table (`records`) and so always equals the base count even when the
 * index is empty (the upgrade case we must catch).
 */
function syncRecordsFts(sqlite: Database.Database): void {
  try {
    const base = sqlite.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }
    const indexed = sqlite.prepare('SELECT COUNT(*) AS n FROM records_fts_docsize').get() as {
      n: number
    }
    if (base.n !== indexed.n) rebuildRecordsFts(sqlite)
  } catch {
    /* records_fts not present on an unusual/old DB — recreated next launch */
  }
}

function ensureNewTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0, balance REAL DEFAULT 0, apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0, credit_limit REAL, institution TEXT NOT NULL DEFAULT '',
      payment_due_date TEXT, last_statement_synced_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
      amount REAL NOT NULL, description TEXT NOT NULL, account_id INTEGER REFERENCES finance_accounts(id),
      category TEXT DEFAULT 'Uncategorized', subcategory TEXT, notes TEXT,
      source_file TEXT, ingested_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS budget_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, subcategory TEXT,
      monthly_amount REAL NOT NULL DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, category TEXT NOT NULL,
      subcategory TEXT, priority INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS knowledge_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forecast_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      date TEXT NOT NULL,
      amount REAL,
      label TEXT,
      kind TEXT NOT NULL,
      shift_to_date TEXT,
      created_at INTEGER
    );
    -- Travel segments (Phase 11.5) — lives here (the always-run fallback) as
    -- well as migration 0021 because the packaged app doesn't bundle migrations.
    CREATE TABLE IF NOT EXISTS travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER
    );
    -- Financial goals (Phase 11.6). Mirrors migration 0022 here (the always-run
    -- fallback) since packaged builds skip migrations.
    CREATE TABLE IF NOT EXISTS financial_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      target_amount REAL NOT NULL DEFAULT 0,
      target_date TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      manual_current REAL NOT NULL DEFAULT 0,
      monthly_contribution REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    -- FX-rate snapshots (Phase 11.1). Lives here (the always-run fallback) as
    -- well as migration 0019 because the packaged app doesn't bundle migrations.
    CREATE TABLE IF NOT EXISTS fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      base TEXT NOT NULL,
      quote TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      fetched_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_rates_date_base_quote ON fx_rates (date, base, quote);
    CREATE TABLE IF NOT EXISTS plaid_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL UNIQUE,
      institution_id TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      cursor TEXT,
      last_synced_at INTEGER,
      error_code TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS simplefin_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL UNIQUE,
      org_name TEXT NOT NULL DEFAULT '',
      org_domain TEXT,
      last_synced_at INTEGER,
      error_code TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS linear_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      state_type TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      team TEXT,
      due_date TEXT,
      synced_at INTEGER
    );
    -- Storehouse "Acquisition Engine" Drop Zone (migrations 0016/0017). These live
    -- ONLY in the drizzle migrations, and the packaged app does not bundle the
    -- migrations folder — so migrate() throws there and these tables would never be
    -- created, breaking every import. Recreate them here (the always-run fallback)
    -- so the timeline + snapshot pages work in production and on pre-existing DBs.
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER,
      title TEXT NOT NULL, body TEXT, payload TEXT,
      dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS records_dedup_hash_unique ON records (dedup_hash);
    CREATE INDEX IF NOT EXISTS idx_records_occurred_at ON records (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_records_source_type ON records (source, type);
    CREATE TABLE IF NOT EXISTS snapshot_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, category TEXT NOT NULL, label TEXT, value TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0, dedup_hash TEXT NOT NULL, provenance TEXT, ingested_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS snapshot_facts_dedup_hash_unique ON snapshot_facts (dedup_hash);
    -- Full-text index over the timeline (Phase 10.7 "Converse"). External-content
    -- FTS5 mirroring records by rowid; the triggers keep it in sync for EVERY writer
    -- (import + the future per-source delete). Lives here (the always-run fallback) as
    -- well as migration 0018 because the packaged app doesn't bundle migrations.
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      title, body, payload,
      content='records', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
      INSERT INTO records_fts(rowid, title, body, payload) VALUES (new.id, new.title, new.body, new.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
      INSERT INTO records_fts(records_fts, rowid, title, body, payload) VALUES('delete', old.id, old.title, old.body, old.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
      INSERT INTO records_fts(records_fts, rowid, title, body, payload) VALUES('delete', old.id, old.title, old.body, old.payload);
      INSERT INTO records_fts(rowid, title, body, payload) VALUES (new.id, new.title, new.body, new.payload);
    END;
  `)

  // Backfill the FTS index for rows that predate it (the triggers only fire on
  // writes AFTER the table exists, so an upgrade leaves existing records unindexed).
  // Cheap on every launch: rebuilds only when the counts diverge.
  syncRecordsFts(sqlite)

  // Backfill new columns on pre-existing tables (safe no-op when columns already exist).
  const addedSyncInterval = ensureColumn(
    sqlite,
    'integrations',
    'sync_interval_minutes',
    'INTEGER NOT NULL DEFAULT 15'
  )
  ensureColumn(sqlite, 'finance_accounts', 'institution', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(sqlite, 'finance_accounts', 'payment_due_date', 'TEXT')
  ensureColumn(sqlite, 'finance_accounts', 'last_statement_synced_at', 'INTEGER')
  const addedGeo = ensureColumn(sqlite, 'finance_transactions', 'geo', "TEXT NOT NULL DEFAULT 'US'")
  const addedPurpose = ensureColumn(sqlite, 'finance_transactions', 'purpose', 'TEXT')
  if (addedGeo) {
    // Backfill geo from notes tokens for existing rows.
    for (const val of ['CR', 'SPAIN', 'COLOMBIA', 'PANAMA', 'OTHER'] as const) {
      try {
        sqlite
          .prepare("UPDATE finance_transactions SET geo = ? WHERE notes LIKE ? AND geo = 'US'")
          .run(val, `%geo:${val}%`)
      } catch {
        /* ignore */
      }
    }
  }
  if (addedGeo || addedPurpose) {
    // Backfill purpose from notes tokens for existing rows.
    for (const val of ['capex', 'household', 'operating', 'travel', 'other'] as const) {
      try {
        sqlite
          .prepare(
            'UPDATE finance_transactions SET purpose = ? WHERE notes LIKE ? AND purpose IS NULL'
          )
          .run(val, `%purpose:${val}%`)
      } catch {
        /* ignore */
      }
    }
  }
  // Phase 4.3 — tax disposition columns. taxYear is derived from `date.year`
  // in SQL (cheap); the taxTag classification runs through the JS classifier
  // (backfillTaxTags below) so the rule logic lives in one place.
  const addedTaxTag = ensureColumn(
    sqlite,
    'finance_transactions',
    'tax_tag',
    "TEXT NOT NULL DEFAULT 'tax:none'"
  )
  ensureColumn(sqlite, 'finance_transactions', 'tax_tag_source', "TEXT NOT NULL DEFAULT 'auto'")
  const addedTaxYear = ensureColumn(sqlite, 'finance_transactions', 'tax_year', 'INTEGER')
  if (addedTaxYear) {
    try {
      sqlite
        .prepare(
          'UPDATE finance_transactions SET tax_year = CAST(SUBSTR(date, 1, 4) AS INTEGER) WHERE tax_year IS NULL'
        )
        .run()
    } catch {
      /* ignore */
    }
  }
  // Mirror the (tax_year, tax_tag) compound index from migration 0005 so the
  // finance:get-tax-summary query stays fast on legacy DBs that bypass the
  // migration runner.
  try {
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS idx_finance_transactions_tax_year_tag ON finance_transactions(tax_year, tax_tag)'
    )
  } catch {
    /* ignore */
  }
  if (addedTaxTag) {
    // Re-classify every existing row so historical Charity / Health /
    // Enndustrious / CR-capex rows aren't silently reported as tax:none.
    // User overrides (tax_tag_source='user') are not touched.
    try {
      backfillTaxTags(sqlite)
    } catch {
      /* ignore — leaves rows at tax:none default; user can re-ingest to retry */
    }
  }
  // Phase 4.4 — net-worth columns. Mirror migration 0006: add asset_class
  // with sensible defaults (debt → liability; savings/investment types →
  // their natural buckets) and create the snapshot index.
  const addedAssetClass = ensureColumn(
    sqlite,
    'finance_accounts',
    'asset_class',
    "TEXT NOT NULL DEFAULT 'spending'"
  )
  if (addedAssetClass) {
    try {
      sqlite
        .prepare("UPDATE finance_accounts SET asset_class = 'liability' WHERE is_debt = 1")
        .run()
      sqlite
        .prepare(
          "UPDATE finance_accounts SET asset_class = 'savings' WHERE is_debt = 0 AND type = 'savings'"
        )
        .run()
      sqlite
        .prepare(
          "UPDATE finance_accounts SET asset_class = 'retirement' WHERE is_debt = 0 AND type = 'investment'"
        )
        .run()
    } catch {
      /* ignore */
    }
  }
  try {
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS idx_finance_balance_snapshots_account_captured ON finance_balance_snapshots(account_id, captured_at)'
    )
  } catch {
    /* ignore */
  }
  // Phase 4.5 — forecast columns + UNIQUE index. payment_day_of_month is
  // nullable (defaults to 1 in the engine when not set). The unique index
  // on (account_id, date, label) lets the IPC use atomic upsert semantics
  // and enforces "at most one override per (account, date, event-label)"
  // at the DB level.
  ensureColumn(sqlite, 'finance_accounts', 'payment_day_of_month', 'INTEGER')
  try {
    // Drop the legacy non-unique index if it exists from a pre-0008 install.
    sqlite.exec('DROP INDEX IF EXISTS idx_forecast_overrides_account_date')
    sqlite.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_forecast_overrides_account_date_label ON forecast_overrides(account_id, date, label)'
    )
  } catch {
    /* ignore */
  }
  // Phase 4.6 — Plaid linkage columns + lookup index. The `plaid_items`
  // table is created in the CREATE TABLE block above; here we just thread
  // the FK columns onto legacy `finance_accounts` rows. All three are
  // nullable so manually-created and CSV-ingested accounts coexist with
  // Plaid-linked ones.
  ensureColumn(sqlite, 'finance_accounts', 'plaid_item_id', 'INTEGER REFERENCES plaid_items(id)')
  ensureColumn(sqlite, 'finance_accounts', 'plaid_account_id', 'TEXT')
  ensureColumn(sqlite, 'finance_accounts', 'mask', 'TEXT')
  try {
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS idx_finance_accounts_plaid ON finance_accounts(plaid_item_id, plaid_account_id)'
    )
  } catch {
    /* ignore */
  }
  // Phase 4.7 — SimpleFIN linkage columns + lookup index. The
  // `simplefin_connections` table is created in the CREATE TABLE block above;
  // here we thread the FK columns onto legacy `finance_accounts` rows. Both
  // nullable so manual / CSV / Plaid / SimpleFIN accounts coexist.
  ensureColumn(
    sqlite,
    'finance_accounts',
    'simplefin_connection_id',
    'INTEGER REFERENCES simplefin_connections(id)'
  )
  ensureColumn(sqlite, 'finance_accounts', 'simplefin_account_id', 'TEXT')
  try {
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS idx_finance_accounts_simplefin ON finance_accounts(simplefin_account_id)'
    )
  } catch {
    /* ignore */
  }
  // Phase 11.1 — multi-currency foundation. Thread an ISO-4217 `currency`
  // column onto legacy `finance_accounts` + `finance_transactions` rows. Both
  // default 'USD' so every pre-existing row keeps its current (USD) meaning;
  // foreign-currency accounts are opted in explicitly via the Accounts UI. The
  // `fx_rates` table itself is created in the CREATE TABLE block above.
  ensureColumn(sqlite, 'finance_accounts', 'currency', "TEXT NOT NULL DEFAULT 'USD'")
  ensureColumn(sqlite, 'finance_transactions', 'currency', "TEXT NOT NULL DEFAULT 'USD'")
  // Phase 11.2 — foreign-account flag for FBAR/FATCA. Backfill non-USD accounts
  // to foreign as a starting guess (the user can correct in the Accounts UI).
  const addedIsForeign = ensureColumn(
    sqlite,
    'finance_accounts',
    'is_foreign',
    'INTEGER NOT NULL DEFAULT 0'
  )
  if (addedIsForeign) {
    try {
      sqlite.prepare("UPDATE finance_accounts SET is_foreign = 1 WHERE currency != 'USD'").run()
    } catch {
      /* ignore */
    }
  }
  if (addedSyncInterval) {
    // One-time migration: seed per-integration intervals from the legacy global setting so users
    // who tuned `syncInterval` keep their preference on existing connected integrations.
    try {
      const legacy = sqlite
        .prepare("SELECT value FROM app_settings WHERE key = 'syncInterval'")
        .get() as { value?: string } | undefined
      const parsed = Number.parseInt(legacy?.value ?? '15', 10)
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1440 && parsed !== 15) {
        sqlite.prepare('UPDATE integrations SET sync_interval_minutes = ?').run(parsed)
      }
    } catch {
      /* app_settings might not exist on a pristine DB — ignore */
    }
  }
  // Re-run migration 0004's geo/purpose backfill against any rows whose
  // `notes` column carries the historical `geo:X` / `purpose:X` tokens
  // but whose indexed columns never got updated. Idempotent; cheap when
  // there's nothing to do.
  try {
    backfillGeoFromNotes(sqlite)
  } catch {
    /* finance_transactions might not exist on a pristine DB — ignore */
  }
}

function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  ddl: string
): boolean {
  const quotedTable = quoteSqliteIdentifier(table)
  const quotedColumn = quoteSqliteIdentifier(column)
  const cols = sqlite.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return false
  sqlite.exec(`ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${ddl}`)
  return true
}

/**
 * Validates and quotes SQLite identifiers used in PRAGMA/ALTER TABLE statements.
 * Only simple alphanumeric identifiers starting with a letter or underscore are allowed.
 */
function quoteSqliteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`)
  }

  return `"${identifier}"`
}

function createTablesIfNeeded(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      connected_at INTEGER,
      last_synced_at INTEGER,
      status TEXT NOT NULL DEFAULT 'disconnected',
      scopes TEXT,
      error_message TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 15
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER REFERENCES integrations(id),
      synced_at INTEGER NOT NULL,
      records_updated INTEGER DEFAULT 0,
      errors TEXT
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL,
      list_date TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      checked INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unchecked',
      category TEXT DEFAULT 'personal',
      sort_order INTEGER DEFAULT 0,
      due_date TEXT,
      source TEXT DEFAULT 'manual',
      source_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS checklist_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL UNIQUE,
      content_md TEXT NOT NULL DEFAULT '',
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      all_day INTEGER DEFAULT 0,
      location TEXT,
      description TEXT,
      html_link TEXT,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS github_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      repo TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      body TEXT,
      labels TEXT,
      due_date TEXT,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS linear_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      state_type TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      team TEXT,
      due_date TEXT,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS gmail_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      from_address TEXT NOT NULL,
      action_summary TEXT,
      snippet TEXT,
      received_at INTEGER,
      snoozed_until TEXT,
      done INTEGER DEFAULT 0,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS drive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      mime_type TEXT,
      url TEXT,
      summary TEXT,
      last_modified INTEGER,
      synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT,
      last_modified INTEGER,
      word_count INTEGER DEFAULT 0,
      auto_updated INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS finance_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'credit',
      is_debt INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      is_foreign INTEGER NOT NULL DEFAULT 0,
      apr REAL DEFAULT 0,
      min_payment REAL DEFAULT 0,
      credit_limit REAL,
      institution TEXT NOT NULL DEFAULT '',
      asset_class TEXT NOT NULL DEFAULT 'spending',
      payment_day_of_month INTEGER,
      payment_due_date TEXT,
      last_statement_synced_at INTEGER,
      plaid_item_id INTEGER REFERENCES plaid_items(id),
      plaid_account_id TEXT,
      mask TEXT,
      simplefin_connection_id INTEGER REFERENCES simplefin_connections(id),
      simplefin_account_id TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS plaid_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL UNIQUE,
      institution_id TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      cursor TEXT,
      last_synced_at INTEGER,
      error_code TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS simplefin_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id TEXT NOT NULL UNIQUE,
      org_name TEXT NOT NULL DEFAULT '',
      org_domain TEXT,
      last_synced_at INTEGER,
      error_code TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS finance_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      captured_at INTEGER NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      base TEXT NOT NULL,
      quote TEXT NOT NULL,
      rate REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      fetched_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_rates_date_base_quote ON fx_rates (date, base, quote);

    CREATE TABLE IF NOT EXISTS travel_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS financial_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      target_amount REAL NOT NULL DEFAULT 0,
      target_date TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      manual_current REAL NOT NULL DEFAULT 0,
      monthly_contribution REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS forecast_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES finance_accounts(id),
      date TEXT NOT NULL,
      amount REAL,
      label TEXT,
      kind TEXT NOT NULL,
      shift_to_date TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS finance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT NOT NULL,
      account_id INTEGER REFERENCES finance_accounts(id),
      category TEXT DEFAULT 'Uncategorized',
      subcategory TEXT,
      notes TEXT,
      source_file TEXT,
      ingested_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS budget_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      subcategory TEXT,
      monthly_amount REAL NOT NULL DEFAULT 0,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT DEFAULT '#6272f1',
      active INTEGER DEFAULT 1,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS habit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER REFERENCES habits(id),
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      path, title, content,
      content='knowledge_files',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS knowledge_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at INTEGER
    );
  `)
}
