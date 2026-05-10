# Fix `npm run db:migrate`

## Goal

Restore `npm run db:migrate` so it actually does something. Currently the
script in `package.json` points at `electron/db/migrate.ts` which doesn't
exist on `main`.

## Why now

The script error doesn't break anything user-visible (because `initDb()` in
`electron/db/client.ts` runs migrations automatically on first connect). But
it's a footgun: agents and humans alike will try the npm script first, get
a `ERR_MODULE_NOT_FOUND`, and waste time. Some workflows (CI seeding,
out-of-band schema syncs) actually need a standalone runner.

## Acceptance criteria

- [ ] `npm run db:migrate` succeeds against an empty data dir, creating the
      schema fresh.
- [ ] `npm run db:migrate` is idempotent — running it against an already-
      migrated DB is a no-op and exits 0.
- [ ] `npm run db:migrate -- --check` exits non-zero if there are pending
      migrations (useful for CI gates).
- [ ] `npm run db:migrate -- --reset` (with explicit `--yes` to confirm)
      drops the DB and re-migrates from scratch.
- [ ] Smoke test in CI runs `npm run db:migrate` against a tmpdir.

## Approach

Create `electron/db/migrate.ts` that mirrors the migration block already
inside `initDb()`:

```ts
#!/usr/bin/env tsx
/**
 * Standalone migration runner. Mirrors the migrate() call inside initDb().
 * Use for CI seeding, manual reset, or pre-flight checks.
 *
 * Run:
 *   npm run db:migrate              # apply pending
 *   npm run db:migrate -- --check   # exit non-zero if pending
 *   npm run db:migrate -- --reset --yes  # nuke and re-migrate (DESTRUCTIVE)
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { DATA_DIR } from '../paths'
import * as schema from './schema'

const MIGRATIONS_FOLDER = join(__dirname, 'migrations')
const DB_PATH = join(DATA_DIR, 'compass.db')

function pendingMigrations(): number {
  if (!existsSync(DB_PATH)) return readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length
  const sqlite = new Database(DB_PATH, { readonly: true })
  try {
    const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
    const applied = new Set<string>()
    try {
      const rows = sqlite.prepare(`SELECT hash FROM "__drizzle_migrations"`).all() as { hash: string }[]
      for (const r of rows) applied.add(r.hash)
    } catch {
      // table doesn't exist yet
      return files.length
    }
    return files.filter((f) => !applied.has(f.hash)).length
  } finally {
    sqlite.close()
  }
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2))

  if (flags.has('--check')) {
    const n = pendingMigrations()
    if (n > 0) {
      console.error(`✖ ${n} pending migration(s)`)
      process.exit(1)
    }
    console.log('✓ schema up to date')
    return
  }

  if (flags.has('--reset')) {
    if (!flags.has('--yes')) {
      console.error('Refusing to reset without --yes. This is destructive.')
      process.exit(1)
    }
    if (existsSync(DB_PATH)) {
      rmSync(DB_PATH)
      console.log(`Removed ${DB_PATH}`)
    }
  }

  if (!existsSync(dirname(DB_PATH))) {
    mkdirSync(dirname(DB_PATH), { recursive: true })
  }

  const sqlite = new Database(DB_PATH)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })

  const before = pendingMigrations()
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  const after = pendingMigrations()

  console.log(`Applied ${before - after} migration(s). ${after} pending.`)
  sqlite.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

`package.json` script stays as-is — `tsx electron/db/migrate.ts` — it'll
just work now.

## Tests

- `electron/db/migrate.test.ts`:
  - Fresh tmpdir → migrate → DB exists, all tables present
  - Run twice → second run reports 0 applied
  - `--check` against empty data dir → exits 1, prints count
  - `--check` against current data dir → exits 0
  - `--reset --yes` → DB removed, then re-migrated

CI: add a `db:migrate` step in `.github/workflows/check.yml` that runs the
script against a tmpdir, asserts exit code 0.

## Out of scope

- A "down migration" command. Compass's policy (per `Docs/schema-reference.md`
  in Pennyworth, but the spirit applies here too) is append-only forward
  migrations.
- Multi-DB support. There's one `compass.db` per user.

## Suggested driver

`migration-author`. Tiny PR (~150 LOC including the test).
