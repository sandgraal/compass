/**
 * Tests for the Knowledge IPC handlers (Phase 6.1 — P1).
 *
 * Scope: the FILE-touching handlers — list/read/write/create/delete +
 * get-prev + search + get-backlinks. These are the security-critical
 * surface (path traversal) and the most-used paths.
 *
 * Out of scope (will be a follow-up PR with DB mocking):
 *   - knowledge:list-suggestions
 *   - knowledge:accept-suggestion
 *   - knowledge:dismiss-suggestion
 *   - knowledge:get-embedding-status
 *   - knowledge:rebuild-embeddings
 *   - knowledge:semantic-search
 *
 * Strategy: in-memory FS (incl. directory entries for readdir + statSync
 * mtime). Mock chokidar so importing the module doesn't try to walk the
 * real `~/knowledge-base/`. Mock the embeddings module so the import
 * tree resolves without a Drizzle DB.
 */

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KB = '/tmp/compass-kb-test'

// ── In-memory FS ─────────────────────────────────────────────────────────────
// We model two things:
//   - files: path → string content (mtime tracked per write)
//   - dirs:  set of directory paths (so existsSync works for both)

type FakeFile = { content: string; mtimeMs: number }
const files = new Map<string, FakeFile>()
const dirs = new Set<string>([KB])
let now = 1_700_000_000_000 // deterministic clock for mtime

function addDirsForPath(p: string): void {
  let cur = p
  while (cur && cur !== '/') {
    cur = cur.replace(/\/[^/]+$/, '')
    if (cur && cur !== '/') dirs.add(cur)
  }
}

// A directory "exists" if it's been explicitly added OR any file lives
// under it. The latter mirrors real filesystem behavior — you can't have
// a file at `/a/b/c.md` without `/a/b` existing as a dir — and lets test
// setups stay terse (just call `files.set` without also having to seed
// every ancestor dir).
const existsSyncMock = vi.fn<(p: string) => boolean>((p) => {
  if (files.has(p) || dirs.has(p)) return true
  const prefix = p.endsWith('/') ? p : `${p}/`
  for (const f of files.keys()) if (f.startsWith(prefix)) return true
  return false
})

const readFileSyncMock = vi.fn<(p: string, enc?: BufferEncoding) => string | Buffer>((p, enc) => {
  const f = files.get(p)
  if (!f) throw new Error(`ENOENT ${p}`)
  return enc ? f.content : Buffer.from(f.content, 'utf8')
})

const writeFileSyncMock = vi.fn<(p: string, content: string) => void>((p, content) => {
  now++
  files.set(p, { content: String(content), mtimeMs: now })
  addDirsForPath(p)
})

const unlinkSyncMock = vi.fn<(p: string) => void>((p) => {
  files.delete(p)
})

const mkdirSyncMock = vi.fn<(p: string, opts?: { recursive?: boolean }) => void>((p) => {
  dirs.add(p)
  addDirsForPath(p)
})

interface FakeDirent {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
}

const readdirSyncMock = vi.fn<(p: string, opts?: { withFileTypes?: boolean }) => FakeDirent[]>(
  (p, _opts) => {
    // List immediate children of `p`. Children come from both `files` and
    // `dirs` — we don't distinguish at write time, we infer here.
    const prefix = p.endsWith('/') ? p : `${p}/`
    const seen = new Set<string>()
    const out: FakeDirent[] = []
    const pushChild = (childName: string, isDir: boolean): void => {
      if (seen.has(childName)) return
      seen.add(childName)
      out.push({
        name: childName,
        isDirectory: () => isDir,
        isFile: () => !isDir
      })
    }
    for (const file of files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) pushChild(rest, false)
      else pushChild(rest.slice(0, slash), true)
    }
    for (const d of dirs) {
      if (!d.startsWith(prefix) || d === p) continue
      const rest = d.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) pushChild(rest, true)
    }
    return out
  }
)

const statSyncMock = vi.fn<(p: string) => { mtimeMs: number }>((p) => {
  const f = files.get(p)
  if (!f) throw new Error(`ENOENT ${p}`)
  return { mtimeMs: f.mtimeMs }
})

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
  statSync: statSyncMock,
  unlinkSync: unlinkSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on: () => undefined,
      close: () => undefined
    })
  }
}))

// Embeddings module is imported by knowledge.ts at module load. Stub the
// surface enough that the import resolves; we don't exercise the
// embedding handlers in this file.
vi.mock('../knowledge/embeddings', () => ({
  DEFAULT_EMBED_MODEL: 'stub',
  buildEmbeddingsIndex: vi.fn(),
  loadIndex: vi.fn(() => null),
  saveIndex: vi.fn(),
  semanticSearch: vi.fn(() => [])
}))

vi.mock('../db/client', () => ({
  getDb: () => {
    throw new Error('getDb not expected in file-handler tests')
  }
}))

vi.mock('../paths', () => ({ KNOWLEDGE_DIR: KB }))

// ── Fake IpcMain + invoke helper ─────────────────────────────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const fakeIpcMain: Pick<IpcMain, 'handle' | 'on'> = {
  handle: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['handle'],
  on: ((channel: string, h: Handler) => {
    handlers[channel] = h
  }) as IpcMain['on']
}

function invoke(h: Handler, ...args: unknown[]): Promise<unknown> {
  // Mirror Electron's ipcMain.handle Promise-wrapping so sync throws
  // surface as rejections to test callers (same shape the real renderer
  // sees).
  return Promise.resolve().then(() => h({}, ...args))
}

async function registerAndGet(channel: string): Promise<Handler> {
  const mod = await import('./knowledge')
  mod.registerKnowledgeHandlers(fakeIpcMain as IpcMain)
  const h = handlers[channel]
  if (!h) throw new Error(`Handler not registered: ${channel}`)
  return h
}

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  files.clear()
  dirs.clear()
  dirs.add(KB)
  now = 1_700_000_000_000
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('knowledge:list-files', () => {
  it('walks every .md under KNOWLEDGE_DIR, recursively', async () => {
    files.set(`${KB}/profile/contact.md`, {
      content: '# Contact\n\nhello',
      mtimeMs: 1_700_000_000_000
    })
    files.set(`${KB}/work/employers.md`, {
      content: '# Employers\n',
      mtimeMs: 1_700_000_000_000
    })
    files.set(`${KB}/notes.txt`, { content: 'ignored', mtimeMs: 1_700_000_000_000 }) // non-md

    const h = await registerAndGet('knowledge:list-files')
    const out = (await invoke(h)) as Array<{ path: string; title: string; category: string }>
    expect(out).toHaveLength(2)
    const paths = out.map((f) => f.path).sort()
    expect(paths).toEqual(['profile/contact.md', 'work/employers.md'])
    expect(out.find((f) => f.path === 'profile/contact.md')?.category).toBe('profile')
  })

  it('returns [] when KNOWLEDGE_DIR does not exist', async () => {
    dirs.clear()
    const h = await registerAndGet('knowledge:list-files')
    const out = (await invoke(h)) as unknown[]
    expect(out).toEqual([])
  })

  it('extracts the title from the first H1, falling back to the filename', async () => {
    files.set(`${KB}/profile/with-h1.md`, { content: '# Real Title\n\nbody', mtimeMs: now })
    files.set(`${KB}/profile/no-h1.md`, { content: 'just text, no heading', mtimeMs: now })
    const h = await registerAndGet('knowledge:list-files')
    const out = (await invoke(h)) as Array<{ path: string; title: string }>
    expect(out.find((f) => f.path === 'profile/with-h1.md')?.title).toBe('Real Title')
    expect(out.find((f) => f.path === 'profile/no-h1.md')?.title).toBe('no-h1')
  })
})

describe('knowledge:read-file', () => {
  it('returns the file contents', async () => {
    files.set(`${KB}/profile/contact.md`, { content: '# Hello', mtimeMs: now })
    const h = await registerAndGet('knowledge:read-file')
    expect(await invoke(h, 'profile/contact.md')).toBe('# Hello')
  })

  it('returns null when the file does not exist', async () => {
    const h = await registerAndGet('knowledge:read-file')
    expect(await invoke(h, 'missing.md')).toBeNull()
  })

  it('blocks path traversal outside KNOWLEDGE_DIR', async () => {
    // The handler joins relativePath onto KNOWLEDGE_DIR and then checks
    // that the resolved path stays inside KB. `../../etc/passwd` resolves
    // outside; reject.
    const h = await registerAndGet('knowledge:read-file')
    await expect(invoke(h, '../../etc/passwd')).rejects.toThrow(/Path traversal/)
  })
})

describe('knowledge:write-file', () => {
  it('writes content to the file at relativePath', async () => {
    const h = await registerAndGet('knowledge:write-file')
    const out = (await invoke(h, 'notes.md', 'hello world')) as { success: boolean }
    expect(out.success).toBe(true)
    expect(files.get(`${KB}/notes.md`)?.content).toBe('hello world')
  })

  it('blocks path traversal', async () => {
    const h = await registerAndGet('knowledge:write-file')
    await expect(invoke(h, '../escape.md', 'x')).rejects.toThrow(/Path traversal/)
    // No write should have happened
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })
})

describe('knowledge:create-file', () => {
  it('seeds a new file with an H1 title heading', async () => {
    const h = await registerAndGet('knowledge:create-file')
    await invoke(h, 'profile/new-note.md', 'My Note')
    expect(files.get(`${KB}/profile/new-note.md`)?.content).toBe('# My Note\n\n')
  })

  it('creates missing parent directories (e.g. general/<slug>.md)', async () => {
    const h = await registerAndGet('knowledge:create-file')
    await invoke(h, 'general/auto-from-wikilink.md', 'From Wikilink')
    // The parent dir gets created via mkdirSync; verify both the dir entry
    // and the file are recorded.
    expect(dirs.has(`${KB}/general`)).toBe(true)
    expect(files.get(`${KB}/general/auto-from-wikilink.md`)?.content).toBe('# From Wikilink\n\n')
  })

  it('refuses to overwrite an existing file', async () => {
    files.set(`${KB}/profile/exists.md`, { content: '# Existing', mtimeMs: now })
    const h = await registerAndGet('knowledge:create-file')
    await expect(invoke(h, 'profile/exists.md', 'Other')).rejects.toThrow(/already exists/)
  })

  it('blocks path traversal', async () => {
    const h = await registerAndGet('knowledge:create-file')
    await expect(invoke(h, '../escape.md', 'x')).rejects.toThrow(/Path traversal/)
  })
})

describe('knowledge:delete-file', () => {
  it('removes the file', async () => {
    files.set(`${KB}/notes.md`, { content: 'gone', mtimeMs: now })
    const h = await registerAndGet('knowledge:delete-file')
    const out = (await invoke(h, 'notes.md')) as { success: boolean }
    expect(out.success).toBe(true)
    expect(files.has(`${KB}/notes.md`)).toBe(false)
  })

  it('also removes the `.prev` sidecar so it does not haunt a re-creation', async () => {
    // The auto-update writer keeps a `.prev` backup. Without this cleanup,
    // deleting + recreating a file would leave a stale prev in place that
    // the user could accidentally restore from.
    files.set(`${KB}/notes.md`, { content: 'current', mtimeMs: now })
    files.set(`${KB}/notes.md.prev`, { content: 'old', mtimeMs: now - 1 })
    const h = await registerAndGet('knowledge:delete-file')
    await invoke(h, 'notes.md')
    expect(files.has(`${KB}/notes.md`)).toBe(false)
    expect(files.has(`${KB}/notes.md.prev`)).toBe(false)
  })

  it('is idempotent — returns success when the file is already gone', async () => {
    const h = await registerAndGet('knowledge:delete-file')
    const out = (await invoke(h, 'ghost.md')) as { success: boolean }
    expect(out.success).toBe(true)
  })

  it('blocks path traversal', async () => {
    const h = await registerAndGet('knowledge:delete-file')
    await expect(invoke(h, '../escape.md')).rejects.toThrow(/Path traversal/)
  })
})

describe('knowledge:get-prev', () => {
  it('returns the .prev backup contents', async () => {
    files.set(`${KB}/notes.md.prev`, { content: 'old version', mtimeMs: now })
    const h = await registerAndGet('knowledge:get-prev')
    expect(await invoke(h, 'notes.md')).toBe('old version')
  })

  it('returns null when no .prev exists', async () => {
    const h = await registerAndGet('knowledge:get-prev')
    expect(await invoke(h, 'notes.md')).toBeNull()
  })

  it('returns null for traversal-shaped paths', async () => {
    // Soft check — this handler uses a `..` substring filter, not the
    // resolve-and-prefix check. Still blocks the common case.
    const h = await registerAndGet('knowledge:get-prev')
    expect(await invoke(h, '../escape')).toBeNull()
  })
})

describe('knowledge:search', () => {
  beforeEach(() => {
    files.set(`${KB}/profile/contact.md`, {
      content: '# Contact\n\nemail: jane@example.com\nphone: 555-1212',
      mtimeMs: now
    })
    files.set(`${KB}/work/employers.md`, {
      content: '# Employers\n\nAcme — 2024-2026',
      mtimeMs: now
    })
  })

  it('returns matching files with a snippet around the first match', async () => {
    const h = await registerAndGet('knowledge:search')
    const out = (await invoke(h, 'jane@example.com')) as Array<{
      path: string
      snippet: string
    }>
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('profile/contact.md')
    expect(out[0].snippet).toContain('jane@example.com')
  })

  it('is case-insensitive', async () => {
    const h = await registerAndGet('knowledge:search')
    const out = (await invoke(h, 'ACME')) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('returns [] when nothing matches', async () => {
    const h = await registerAndGet('knowledge:search')
    expect(await invoke(h, 'never-appears-anywhere')).toEqual([])
  })
})

describe('knowledge:get-backlinks', () => {
  it('finds files containing [[<target>]] and returns their snippets', async () => {
    // Target: profile/contact.md (title "Contact")
    files.set(`${KB}/profile/contact.md`, { content: '# Contact\n\nme', mtimeMs: now })
    // Two referencers, one not.
    files.set(`${KB}/work/job.md`, {
      content: 'spoke with [[Contact]] about the role',
      mtimeMs: now
    })
    files.set(`${KB}/notes/random.md`, {
      content: 'see [[contact]] (case insensitive)',
      mtimeMs: now
    })
    files.set(`${KB}/notes/unrelated.md`, { content: 'nothing here', mtimeMs: now })

    const h = await registerAndGet('knowledge:get-backlinks')
    const out = (await invoke(h, 'profile/contact.md')) as Array<{ path: string }>
    const paths = out.map((r) => r.path).sort()
    expect(paths).toEqual(['notes/random.md', 'work/job.md'])
  })

  it('matches [[basename|display]] form on the basename, not the display text', async () => {
    files.set(`${KB}/profile/contact.md`, { content: '# Contact\n', mtimeMs: now })
    files.set(`${KB}/notes/aliased.md`, {
      content: 'see [[contact|Jane Doe]] for details',
      mtimeMs: now
    })
    const h = await registerAndGet('knowledge:get-backlinks')
    const out = (await invoke(h, 'profile/contact.md')) as Array<{ path: string }>
    expect(out.map((r) => r.path)).toEqual(['notes/aliased.md'])
  })

  it('does not list the target as backlinking to itself', async () => {
    files.set(`${KB}/profile/contact.md`, {
      content: '# Contact\n\nself-ref [[Contact]]',
      mtimeMs: now
    })
    const h = await registerAndGet('knowledge:get-backlinks')
    const out = (await invoke(h, 'profile/contact.md')) as unknown[]
    expect(out).toEqual([])
  })

  it('rejects traversal-shaped paths (returns [])', async () => {
    const h = await registerAndGet('knowledge:get-backlinks')
    expect(await invoke(h, '../escape')).toEqual([])
    expect(await invoke(h, 42 as unknown as string)).toEqual([])
  })

  it('returns [] when the target file does not exist', async () => {
    const h = await registerAndGet('knowledge:get-backlinks')
    expect(await invoke(h, 'profile/ghost.md')).toEqual([])
  })
})

// ─── Path traversal: prefix-bypass regression (Phase 6.1 — Copilot review) ───
//
// `KNOWLEDGE_DIR === '/tmp/compass-kb-test'`. A path like
// `../compass-kb-test-evil/x.md` resolves to
// `/tmp/compass-kb-test-evil/x.md` — which `startsWith('/tmp/compass-kb-test')`
// returns `true` for if you use a string-prefix check. That used to be the
// production check pattern across read/write/create/delete; switching to
// `relative(base, resolved)` containment closes the hole.

describe('path traversal — prefix-bypass (sibling-with-shared-prefix)', () => {
  const SIBLING = '../compass-kb-test-evil/secret.md'

  it('knowledge:read-file rejects sibling-prefix paths', async () => {
    const h = await registerAndGet('knowledge:read-file')
    await expect(invoke(h, SIBLING)).rejects.toThrow(/Path traversal/)
  })

  it('knowledge:write-file rejects sibling-prefix paths', async () => {
    const h = await registerAndGet('knowledge:write-file')
    await expect(invoke(h, SIBLING, 'attacker payload')).rejects.toThrow(/Path traversal/)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('knowledge:create-file rejects sibling-prefix paths', async () => {
    const h = await registerAndGet('knowledge:create-file')
    await expect(invoke(h, SIBLING, 'Evil')).rejects.toThrow(/Path traversal/)
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('knowledge:delete-file rejects sibling-prefix paths', async () => {
    const h = await registerAndGet('knowledge:delete-file')
    await expect(invoke(h, SIBLING)).rejects.toThrow(/Path traversal/)
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })

  it('knowledge:get-prev returns null (fails soft) on sibling-prefix paths', async () => {
    const h = await registerAndGet('knowledge:get-prev')
    expect(await invoke(h, SIBLING)).toBeNull()
  })

  it('knowledge:get-backlinks returns [] (fails soft) on sibling-prefix paths', async () => {
    const h = await registerAndGet('knowledge:get-backlinks')
    expect(await invoke(h, SIBLING)).toEqual([])
  })

  it('also rejects absolute paths that escape KNOWLEDGE_DIR', async () => {
    // Belt-and-suspenders: a renderer passing an absolute path that
    // doesn't even share the prefix must also be rejected. With raw
    // join + startsWith, an absolute path would overwrite the join
    // result entirely (path.join discards the prefix when the second
    // arg is absolute) and then fail the startsWith. The safeJoin
    // helper rejects via the relative-check path; verify.
    const h = await registerAndGet('knowledge:read-file')
    await expect(invoke(h, '/etc/passwd')).rejects.toThrow(/Path traversal/)
  })
})
