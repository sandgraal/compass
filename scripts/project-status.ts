#!/usr/bin/env tsx
/**
 * Generate `.claude/project-status.json` — a structured snapshot of the
 * repo's current state intended for agent orientation. When a new agent
 * session starts in this repo, reading this JSON is faster than scanning
 * the whole codebase to learn what's shipped and what's not.
 *
 * Run: `npm run status`
 *
 * Phase 0+.10 in the implementation plan.
 *
 * IMPORTANT: this file is purely descriptive — nothing reads it at
 * runtime. It can drift between regenerations; that's the trade-off.
 * Future work (Phase 0+.6 living-docs hook) can auto-regen on schema /
 * preload edits if drift becomes a problem.
 */

import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')

type Status = {
  generatedAt: string
  appVersion: string
  db: {
    tables: number
    tableNames: string[]
    migrations: number
    latestMigration: string | null
  }
  ipc: {
    handlerCount: number
    handlersByDomain: Record<string, number>
  }
  tests: {
    files: number
    list: string[]
  }
  phases: Array<{ id: string; name: string; status: string }>
  recentMerges: Array<{ sha: string; title: string; date: string }>
}

function readFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function getAppVersion(): string {
  const pkg = JSON.parse(readFile('package.json')) as { version: string }
  return pkg.version
}

function getDbInfo(): Status['db'] {
  const schema = readFile('electron/db/schema.ts')
  // Match `export const foo = sqliteTable('foo_name', { ... })`
  const tableMatches = [...schema.matchAll(/sqliteTable\(\s*['"]([a-z_]+)['"]/g)]
  const tableNames = tableMatches.map((m) => m[1]).sort()

  const migDir = join(ROOT, 'electron/db/migrations')
  const migrations = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const latestMigration = migrations.length
    ? migrations[migrations.length - 1].replace(/\.sql$/, '')
    : null

  return {
    tables: tableNames.length,
    tableNames,
    migrations: migrations.length,
    latestMigration
  }
}

function getIpcInfo(): Status['ipc'] {
  // grep for `ipcMain.handle(` across all electron/ TS files.
  const lines = exec("grep -rEn 'ipcMain\\.handle\\(' electron/ --include='*.ts'")
    .split('\n')
    .filter(Boolean)

  // Bucket by source filename: `electron/ipc/<domain>.ts` → `domain`;
  // anything else → its basename so `electron/main.ts` shows up as `main`.
  const byDomain: Record<string, number> = {}
  for (const line of lines) {
    const ipcMatch = line.match(/electron\/ipc\/([^/.]+)\.ts:/)
    let domain = ipcMatch?.[1]
    if (!domain) {
      const fileMatch = line.match(/electron\/([^:]+):/)
      domain = fileMatch?.[1]?.replace(/\.ts$/, '').replace(/\//g, '_') ?? 'unknown'
    }
    byDomain[domain] = (byDomain[domain] ?? 0) + 1
  }
  return { handlerCount: lines.length, handlersByDomain: byDomain }
}

function getTestsInfo(): Status['tests'] {
  const list = exec("find electron src -name '*.test.ts' -o -name '*.test.tsx'")
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ''))
    .sort()
  return { files: list.length, list }
}

/**
 * Parse the phase status snapshot table from `docs/implementation_plan.md`.
 * The table looks like:
 *
 *   | **Phase 0** — Agent infrastructure | 7 sub-areas | 100% |
 *
 * We extract the bolded phase name + the % column.
 */
function getPhases(): Status['phases'] {
  const plan = readFile('docs/implementation_plan.md')
  const phases: Status['phases'] = []
  const rowRe = /^\|\s*\*\*([^*]+)\*\*\s*[—-]\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm
  let match: RegExpExecArray | null
  while (true) {
    match = rowRe.exec(plan)
    if (match === null) break
    const id = match[1].trim()
    const name = match[2].trim()
    const status = match[4].trim()
    phases.push({ id, name, status })
  }
  return phases
}

function getRecentMerges(): Status['recentMerges'] {
  // Last 8 merge commits along the current branch's first-parent line.
  // We prefer `origin/main` when available (so a worktree branched from
  // a stale local `main` still sees the live merge log) and fall back to
  // HEAD otherwise.
  const ref = exec('git rev-parse --verify -q origin/main') ? 'origin/main' : 'HEAD'
  const raw = exec(`git log --merges --first-parent --pretty=format:'%h|%s|%cs' -n 8 ${ref}`)
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, title, date] = line.split('|')
      return { sha, title, date }
    })
}

function main(): void {
  const status: Status = {
    generatedAt: new Date().toISOString(),
    appVersion: getAppVersion(),
    db: getDbInfo(),
    ipc: getIpcInfo(),
    tests: getTestsInfo(),
    phases: getPhases(),
    recentMerges: getRecentMerges()
  }

  const outPath = join(ROOT, '.claude/project-status.json')
  writeFileSync(outPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  console.log(`✓ wrote ${outPath}`)
  console.log(
    `  ${status.db.tables} tables · ${status.ipc.handlerCount} IPC handlers · ${status.tests.files} test files · ${status.phases.length} phases`
  )
}

main()
