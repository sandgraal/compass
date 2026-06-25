import { cpSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Copy the Drizzle migrations next to the built main process so the runtime
 * `migrate()` call in {@link ./client.ts} — which resolves
 * `join(__dirname, 'migrations')` — finds them in BOTH `electron-vite dev` and
 * the packaged asar.
 *
 * Why this exists: electron-vite only emits the bundled JS to `out/main`; it
 * does not copy sibling data files. Without this step `out/main/migrations`
 * never exists, so `migrate()` throws in every built app and the hand-written
 * `ensureNewTables()` fallback is the ONLY thing that creates tables. That
 * fallback has to be kept in lockstep with every new migration by hand — and a
 * miss there shipped a production bug (the Storehouse `records` /
 * `snapshot_facts` tables were never created). electron-builder bundles
 * `out/**` into the asar, so once these files land in `out/main/migrations`
 * they travel with the release and `migrate()` works for real.
 *
 * Only the files the migrator/reconciler read at runtime are copied: the
 * per-migration `*.sql` files and `meta/_journal.json`. Drizzle-kit's
 * `meta/*_snapshot.json` files are used solely to GENERATE new migrations
 * (via `drizzle-kit generate`) and are excluded to keep the asar lean.
 *
 * @returns the destination migrations directory (`<outDir>/migrations`).
 */
export function copyMigrationsToBuild(sourceDir: string, outDir: string): string {
  const dest = join(outDir, 'migrations')
  cpSync(sourceDir, dest, {
    recursive: true,
    filter: (src) => !src.endsWith('_snapshot.json')
  })
  return dest
}
