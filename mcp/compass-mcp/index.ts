import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
/**
 * Compass MCP Server
 *
 * Exposes Compass's local SQLite + knowledge base as a read-only MCP server
 * so Claude can answer "what's on my schedule today?" or "search my knowledge
 * base for X" while coding — closing the dogfooding loop.
 *
 * Vault fields and OAuth tokens are EXPLICITLY EXCLUDED. Returned data may
 * include user content (task titles, calendar event titles, knowledge files).
 *
 * Run: tsx mcp/compass-mcp/index.ts
 * Register in .mcp.json (already done at repo root).
 */
import Database from 'better-sqlite3'

// Mirror electron/paths.ts — but we open the DB read-only
const APP_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Compass')
const DB_PATH = join(APP_DATA_DIR, '.data', 'compass.db')
const KNOWLEDGE_DIR = join(APP_DATA_DIR, 'knowledge-base')

// Repo root, derived from this file's location (mcp/compass-mcp/index.ts).
// Used by the self-knowledge tools that introspect the source tree (git log,
// test inventory) rather than the user's app data.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function openDb(): Database.Database | null {
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
}

const server = new Server(
  { name: 'compass-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

// ============================================================
// Tool definitions
// ============================================================

const TOOLS = [
  {
    name: 'compass_today_tasks',
    description:
      "Returns all tasks on today's daily checklist (manual + auto-pulled from Gmail/GitHub/Calendar). Read-only.",
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'compass_search_knowledge',
    description:
      'Full-text search across all knowledge-base markdown files. Returns matching files with snippets. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (case-insensitive substring match)' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'compass_recent_calendar',
    description:
      'Returns calendar events in the next N days from synced sources (Google + Apple). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'compass_sync_status',
    description: 'Returns last sync time + status for each connected integration. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'compass_read_knowledge_file',
    description:
      'Read the full contents of a specific knowledge-base markdown file. Path must be relative (e.g. "profile/personal.md"). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'compass_recent_commits',
    description:
      'Returns the most recent git commits on the current branch (sha, subject, author, relative date). Lets an agent learn what shipped recently without shelling out. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'compass_test_status',
    description:
      'Reports the test-suite state. By default returns a static inventory (test file count + names) for a fast answer. Pass run=true to actually execute `npm run test:run` and return the pass/fail summary (slower, ~10s). Read-only with respect to source.',
    inputSchema: {
      type: 'object',
      properties: {
        run: {
          type: 'boolean',
          default: false,
          description:
            'If true, execute the suite and return pass/fail counts. If false, return inventory only.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'compass_integration_health',
    description:
      'Returns a per-integration health view: connection status, last sync time, last error, and recent sync-event counts (records updated + error count over the last N events). Richer than compass_sync_status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        recentEvents: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      additionalProperties: false
    }
  }
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

// ============================================================
// Tool handlers
// ============================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'compass_today_tasks') {
      const db = openDb()
      if (!db) return errorResult('Compass DB not found — is the app installed?')
      const today = new Date().toISOString().slice(0, 10)
      const rows = db
        .prepare(
          'SELECT id, title, body, category, checked, source FROM checklist_items WHERE list_type = ? AND list_date = ? ORDER BY sort_order'
        )
        .all('daily', today)
      db.close()
      return textResult(JSON.stringify(rows, null, 2))
    }

    if (name === 'compass_search_knowledge') {
      const query = String(args?.query || '').toLowerCase()
      if (!query) return errorResult('query is required')
      const results = walkKnowledge()
        .map((f) => {
          const idx = f.content.toLowerCase().indexOf(query)
          if (idx < 0) return null
          const snippet = f.content.slice(Math.max(0, idx - 80), idx + 200).replace(/\n/g, ' ')
          return { path: f.path, title: f.title, snippet }
        })
        .filter(Boolean)
      return textResult(JSON.stringify(results, null, 2))
    }

    if (name === 'compass_recent_calendar') {
      const db = openDb()
      if (!db) return errorResult('Compass DB not found')
      const days = Number(args?.days || 7)
      const now = Date.now()
      const cutoff = now + days * 24 * 60 * 60 * 1000
      const rows = db
        .prepare(
          'SELECT id, source, title, start_at, end_at, all_day, location FROM calendar_events WHERE start_at IS NOT NULL ORDER BY start_at'
        )
        .all() as Array<{ start_at: number | null }>
      const filtered = rows.filter((r) => r.start_at && r.start_at >= now && r.start_at <= cutoff)
      db.close()
      return textResult(JSON.stringify(filtered, null, 2))
    }

    if (name === 'compass_sync_status') {
      const db = openDb()
      if (!db) return errorResult('Compass DB not found')
      const rows = db
        .prepare('SELECT service, status, last_synced_at, error_message FROM integrations')
        .all()
      db.close()
      return textResult(JSON.stringify(rows, null, 2))
    }

    if (name === 'compass_read_knowledge_file') {
      const path = String(args?.path || '')
      if (path.includes('..') || !path.endsWith('.md')) {
        return errorResult('invalid path')
      }
      const fullPath = join(KNOWLEDGE_DIR, path)
      // Resolve symlinks to prevent traversal via symlinks inside KNOWLEDGE_DIR
      let resolvedPath: string
      try {
        resolvedPath = realpathSync(fullPath)
      } catch {
        return errorResult('file not found')
      }
      if (!resolvedPath.startsWith(KNOWLEDGE_DIR + sep))
        return errorResult('path traversal blocked')
      const content = readFileSync(resolvedPath, 'utf8')
      return textResult(content)
    }

    if (name === 'compass_recent_commits') {
      const limit = Math.min(50, Math.max(1, Number(args?.limit ?? 10)))
      // execFileSync (not execSync) so the limit can't be shell-injected.
      let out: string
      try {
        out = execFileSync('git', ['log', `-${limit}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%cr'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 10_000
        })
      } catch (err) {
        return errorResult(`git log failed: ${(err as Error).message}`)
      }
      const commits = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, subject, author, date] = line.split('\u001f')
          return { sha, subject, author, date }
        })
      return textResult(JSON.stringify(commits, null, 2))
    }

    if (name === 'compass_test_status') {
      const run = Boolean(args?.run ?? false)
      const testFiles = walkTestFiles()
      if (!run) {
        return textResult(
          JSON.stringify(
            {
              mode: 'inventory',
              testFileCount: testFiles.length,
              testFiles,
              note: 'Static inventory only. Pass run=true to execute the suite and get pass/fail counts.'
            },
            null,
            2
          )
        )
      }
      // run=true: execute the suite. Vitest exits non-zero on failure, so we
      // capture stdout from the thrown error too.
      let raw: string
      let passed = true
      try {
        raw = execFileSync('npm', ['run', 'test:run'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 180_000,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        passed = false
        const e = err as { stdout?: string; stderr?: string; message: string }
        raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}` || e.message
      }
      // Pull the Vitest summary lines (Test Files / Tests). Strip ANSI color
      // codes via a constructed RegExp — the ESC byte cannot appear in a regex
      // literal without tripping Biome's noControlCharactersInRegex rule.
      const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
      const summary = raw
        .split('\n')
        .filter((l) => /Test Files|Tests\s+\d|Duration/.test(l))
        .map((l) => l.replace(ansi, '').trim())
      return textResult(
        JSON.stringify({ mode: 'run', passed, summary, testFileCount: testFiles.length }, null, 2)
      )
    }

    if (name === 'compass_integration_health') {
      const db = openDb()
      if (!db) return errorResult('Compass DB not found')
      const recentEvents = Math.min(100, Math.max(1, Number(args?.recentEvents ?? 20)))
      const integrations = db
        .prepare(
          'SELECT id, service, status, connected_at, last_synced_at, error_message, sync_interval_minutes FROM integrations'
        )
        .all() as Array<{ id: number; service: string }>
      const eventStmt = db.prepare(
        "SELECT COUNT(*) AS events, COALESCE(SUM(records_updated), 0) AS records, SUM(CASE WHEN errors IS NOT NULL AND errors != '' THEN 1 ELSE 0 END) AS errorEvents, MAX(synced_at) AS lastEventAt FROM (SELECT * FROM sync_events WHERE integration_id = ? ORDER BY synced_at DESC LIMIT ?)"
      )
      const health = integrations.map((row) => {
        const agg = eventStmt.get(row.id, recentEvents) as {
          events: number
          records: number
          errorEvents: number
          lastEventAt: number | null
        }
        return { ...row, recentWindow: recentEvents, ...agg }
      })
      db.close()
      return textResult(JSON.stringify(health, null, 2))
    }

    return errorResult(`Unknown tool: ${name}`)
  } catch (err) {
    return errorResult(`Error: ${(err as Error).message}`)
  }
})

// ============================================================
// Helpers
// ============================================================

function walkKnowledge(): Array<{ path: string; title: string; content: string }> {
  try {
    const results: Array<{ path: string; title: string; content: string }> = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) walk(fullPath)
        else if (entry.isFile() && extname(entry.name) === '.md') {
          const relPath = relative(KNOWLEDGE_DIR, fullPath)
          const content = readFileSync(fullPath, 'utf8')
          const titleMatch = content.match(/^#\s+(.+)$/m)
          results.push({ path: relPath, title: titleMatch?.[1].trim() || entry.name, content })
        }
      }
    }
    walk(KNOWLEDGE_DIR)
    return results
  } catch {
    return []
  }
}

function walkTestFiles(): string[] {
  const roots = ['electron', 'src', 'scripts']
  const skip = new Set(['node_modules', '.git', 'out', 'dist', '.vite', '.turbo'])
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
        found.push(relative(REPO_ROOT, full))
      }
    }
  }
  for (const r of roots) walk(join(REPO_ROOT, r))
  return found.sort()
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

// ============================================================
// Run
// ============================================================

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('compass-mcp listening on stdio')
