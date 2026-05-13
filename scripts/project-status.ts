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
 * Implementation notes:
 * - File enumeration walks directories in Node — no shelling out to
 *   `find` / `grep` / `awk`. That avoids portability headaches across
 *   GNU vs BSD vs minimal CI images.
 * - Individual section failures are isolated: a missing directory or a
 *   parse error in one section emits a `[status] warn:` line to stderr
 *   and leaves the field at a safe default (0 / null / []). The whole
 *   command still exits 0 with the rest of the snapshot intact.
 * - `git log` IS shelled out (no point reimplementing) but failures are
 *   surfaced via the same warn channel rather than silently swallowed.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

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

function warn(msg: string): void {
  process.stderr.write(`[status] warn: ${msg}\n`)
}

function readFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/**
 * Walk a directory tree depth-first, yielding repo-relative POSIX paths
 * for every regular file under `dir`. Skips common churn directories.
 * Returns `[]` if the root path doesn't exist.
 */
function walkFiles(dir: string): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  const out: string[] = []
  const skip = new Set(['node_modules', '.git', 'out', 'dist', '.vite', '.turbo'])

  const visit = (p: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch (err) {
      warn(`readdir ${p}: ${err instanceof Error ? err.message : err}`)
      return
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue
      const child = join(p, entry.name)
      if (entry.isDirectory()) {
        visit(child)
      } else if (entry.isFile()) {
        // Repo-relative POSIX path so the JSON is platform-stable.
        out.push(relative(ROOT, child).split(sep).join(posix.sep))
      }
    }
  }
  visit(abs)
  return out
}

function getAppVersion(): string {
  try {
    const pkg = JSON.parse(readFile('package.json')) as { version: string }
    return pkg.version
  } catch (err) {
    warn(`read package.json: ${err instanceof Error ? err.message : err}`)
    return 'unknown'
  }
}

function getDbInfo(): Status['db'] {
  let tableNames: string[] = []
  try {
    const schema = readFile('electron/db/schema.ts')
    // Match `sqliteTable('foo_name', ...)`.
    const tableMatches = [...schema.matchAll(/sqliteTable\(\s*['"]([a-z_]+)['"]/g)]
    tableNames = tableMatches.map((m) => m[1]).sort()
  } catch (err) {
    warn(`read schema.ts: ${err instanceof Error ? err.message : err}`)
  }

  let migrations: string[] = []
  const migDir = join(ROOT, 'electron/db/migrations')
  if (existsSync(migDir)) {
    try {
      migrations = readdirSync(migDir)
        .filter((f) => f.endsWith('.sql') && statSync(join(migDir, f)).isFile())
        .sort()
    } catch (err) {
      warn(`readdir migrations: ${err instanceof Error ? err.message : err}`)
    }
  } else {
    warn('electron/db/migrations does not exist; migration count = 0')
  }

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

/**
 * Scan all `.ts` files under `electron/` for `ipcMain.handle(` and bucket
 * by source domain. `electron/ipc/<x>.ts` → `<x>`; anything else uses
 * its basename so the lone `electron/main.ts` handler shows up as `main`.
 */
function getIpcInfo(): Status['ipc'] {
  const handlerRe = /ipcMain\.handle\s*\(/g
  const files = walkFiles('electron').filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
  const byDomain: Record<string, number> = {}
  let total = 0

  for (const file of files) {
    let content: string
    try {
      content = readFile(file)
    } catch (err) {
      warn(`read ${file}: ${err instanceof Error ? err.message : err}`)
      continue
    }
    const count = (content.match(handlerRe) ?? []).length
    if (count === 0) continue

    const ipcMatch = file.match(/^electron\/ipc\/([^/]+)\.ts$/)
    let domain = ipcMatch?.[1]
    if (!domain) {
      // `electron/foo/bar.ts` → `foo_bar`; `electron/main.ts` → `main`.
      domain = file
        .replace(/^electron\//, '')
        .replace(/\.ts$/, '')
        .replace(/\//g, '_')
    }
    byDomain[domain] = (byDomain[domain] ?? 0) + count
    total += count
  }
  return { handlerCount: total, handlersByDomain: byDomain }
}

function getTestsInfo(): Status['tests'] {
  // Look in both electron/ and src/ for `.test.ts` and `.test.tsx`.
  const allFiles = [...walkFiles('electron'), ...walkFiles('src')]
  const list = allFiles.filter((p) => p.endsWith('.test.ts') || p.endsWith('.test.tsx')).sort()
  return { files: list.length, list }
}

/**
 * Parse the phase status snapshot table from `docs/implementation_plan.md`.
 * Each row looks like:
 *
 *   | **Phase 0** — Agent infrastructure | 7 sub-areas | 100% |
 *
 * We extract the bolded phase name + the % column.
 */
function getPhases(): Status['phases'] {
  let plan: string
  try {
    plan = readFile('docs/implementation_plan.md')
  } catch (err) {
    warn(`read implementation_plan.md: ${err instanceof Error ? err.message : err}`)
    return []
  }
  const phases: Status['phases'] = []
  const rowRe = /^\|\s*\*\*([^*]+)\*\*\s*[—-]\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm
  let match: RegExpExecArray | null
  while (true) {
    match = rowRe.exec(plan)
    if (match === null) break
    phases.push({ id: match[1].trim(), name: match[2].trim(), status: match[4].trim() })
  }
  return phases
}

function tryGit(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    warn(`git command failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
    return null
  }
}

function getRecentMerges(): Status['recentMerges'] {
  // Last 8 merge commits along the current branch's first-parent line.
  // Prefer `origin/main` so a worktree branched from a stale local `main`
  // still sees the live merge log; fall back to `HEAD` otherwise.
  const ref = tryGit('git rev-parse --verify -q origin/main') ? 'origin/main' : 'HEAD'
  const raw = tryGit(`git log --merges --first-parent --pretty=format:'%h|%s|%cs' -n 8 ${ref}`)
  if (raw == null) return []
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
