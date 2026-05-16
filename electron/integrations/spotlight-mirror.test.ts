/**
 * Tests for the Spotlight mirror's pure helpers + the disk-level
 * reconcile / apply-change paths. The watcher and IPC layers are not
 * unit-tested here — those are integration concerns covered by the
 * smoke test in the PR plan.
 *
 * We never mirror to the real ~/Documents during tests; every path
 * goes through `mkdtempSync` to keep the host clean.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _internal,
  applyMirrorChange,
  defaultMirrorPath,
  isAllowedMirrorPath,
  mirrorTargetFor,
  normalizedMirrorPath,
  reconcileMirror
} from './spotlight-mirror'

// Pin the "home" to a temp dir per test so `isAllowedMirrorPath`'s
// "must be under ~/Documents / ~/Desktop" check is testable without
// touching the real $HOME.
let TMP_HOME: string
vi.mock('node:os', async (orig) => {
  const real = (await orig()) as typeof import('node:os')
  return { ...real, homedir: () => TMP_HOME }
})

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), 'compass-spotlight-home-'))
  mkdirSync(join(TMP_HOME, 'Documents'), { recursive: true })
  mkdirSync(join(TMP_HOME, 'Desktop'), { recursive: true })
})

afterEach(() => {
  rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('isAllowedMirrorPath', () => {
  it('accepts paths inside ~/Documents', () => {
    expect(isAllowedMirrorPath(join(TMP_HOME, 'Documents', 'Compass Notes'))).toBe(true)
  })
  it('accepts paths inside ~/Desktop', () => {
    expect(isAllowedMirrorPath(join(TMP_HOME, 'Desktop', 'Notes'))).toBe(true)
  })

  // Catastrophic-delete defense: if we accepted the bare folder, the
  // prune pass would treat the whole Documents/Desktop tree as
  // Compass-owned and recursively delete every .md not in the KB.
  // Must be a dedicated subdirectory.
  it('rejects bare ~/Documents itself', () => {
    expect(isAllowedMirrorPath(join(TMP_HOME, 'Documents'))).toBe(false)
  })
  it('rejects bare ~/Desktop itself', () => {
    expect(isAllowedMirrorPath(join(TMP_HOME, 'Desktop'))).toBe(false)
  })

  it('rejects Library Application Support paths', () => {
    expect(isAllowedMirrorPath(join(TMP_HOME, 'Library', 'Application Support', 'Compass'))).toBe(
      false
    )
  })
  it('rejects relative paths', () => {
    expect(isAllowedMirrorPath('Documents/Notes')).toBe(false)
  })
  it('rejects a path that only LOOKS like Documents (no separator)', () => {
    // ~/Documents-evil should NOT match ~/Documents.
    expect(isAllowedMirrorPath(join(TMP_HOME, 'Documents-evil'))).toBe(false)
  })
  it('expands ~ in the path', () => {
    expect(isAllowedMirrorPath('~/Documents/Compass Notes')).toBe(true)
  })

  // Path-traversal defense: a raw-string prefix check would happily
  // pass `~/Documents/../Library/...` even though it escapes the
  // allowlist. We resolve `..` segments before comparing.
  it('rejects path traversal that escapes ~/Documents', () => {
    expect(
      isAllowedMirrorPath(`${TMP_HOME}/Documents/../Library/Application Support/Compass Mirror`)
    ).toBe(false)
  })
  it('rejects path traversal that escapes ~/Desktop', () => {
    expect(isAllowedMirrorPath(`${TMP_HOME}/Desktop/../private/notes`)).toBe(false)
  })

  it('rejects empty / non-string input', () => {
    expect(isAllowedMirrorPath('')).toBe(false)
    expect(isAllowedMirrorPath(undefined as unknown as string)).toBe(false)
  })
})

describe('normalizedMirrorPath', () => {
  it('returns the resolved absolute path for an allowed input', () => {
    expect(normalizedMirrorPath('~/Documents/Compass Notes')).toBe(
      join(TMP_HOME, 'Documents', 'Compass Notes')
    )
  })
  it('collapses `..` segments BEFORE allowlist check (returns null for escapes)', () => {
    expect(normalizedMirrorPath(`${TMP_HOME}/Documents/../Library/Compass Mirror`)).toBeNull()
  })
  it('returns null for the bare root', () => {
    expect(normalizedMirrorPath(`${TMP_HOME}/Documents`)).toBeNull()
  })
})

describe('defaultMirrorPath', () => {
  it('lives under ~/Documents and points at "Compass Notes"', () => {
    expect(defaultMirrorPath()).toBe(join(TMP_HOME, 'Documents', 'Compass Notes'))
  })
})

describe('mirrorTargetFor', () => {
  it('maps a nested knowledge path one-to-one', () => {
    expect(mirrorTargetFor('/m', 'profile/health.md')).toBe('/m/profile/health.md')
  })
  it('handles top-level files', () => {
    expect(mirrorTargetFor('/m', 'index.md')).toBe('/m/index.md')
  })
})

describe('reconcileMirror', () => {
  let kbRoot: string
  let mirrorRoot: string

  beforeEach(() => {
    kbRoot = mkdtempSync(join(tmpdir(), 'compass-kb-'))
    mirrorRoot = join(TMP_HOME, 'Documents', 'Compass Notes')
  })

  afterEach(() => {
    rmSync(kbRoot, { recursive: true, force: true })
  })

  function writeKb(rel: string, content: string): void {
    const full = join(kbRoot, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  it('copies every .md from kbRoot under mirrorRoot', () => {
    writeKb('profile/health.md', '# Health')
    writeKb('work/projects.md', '# Projects')
    const result = reconcileMirror(kbRoot, mirrorRoot)
    expect(result.copied).toBe(2)
    expect(existsSync(join(mirrorRoot, 'profile', 'health.md'))).toBe(true)
    expect(existsSync(join(mirrorRoot, 'work', 'projects.md'))).toBe(true)
  })

  it('writes a README that explains the one-way-mirror semantics', () => {
    writeKb('a.md', 'x')
    reconcileMirror(kbRoot, mirrorRoot)
    const { README_FILENAME, README_BODY } = _internal
    expect(readFileSync(join(mirrorRoot, README_FILENAME), 'utf8')).toBe(README_BODY)
  })

  it('skips unchanged files on a second reconcile', () => {
    writeKb('a.md', 'unchanged')
    reconcileMirror(kbRoot, mirrorRoot)
    const r2 = reconcileMirror(kbRoot, mirrorRoot)
    expect(r2.copied).toBe(0)
    expect(r2.skipped).toBe(1)
  })

  it('prunes mirrored files whose source is gone', () => {
    writeKb('a.md', 'x')
    writeKb('b.md', 'y')
    reconcileMirror(kbRoot, mirrorRoot)
    rmSync(join(kbRoot, 'b.md'))
    const r2 = reconcileMirror(kbRoot, mirrorRoot)
    expect(r2.removed).toBe(1)
    expect(existsSync(join(mirrorRoot, 'b.md'))).toBe(false)
    expect(existsSync(join(mirrorRoot, 'a.md'))).toBe(true)
  })

  it('rejects an off-limits mirror path', () => {
    writeKb('a.md', 'x')
    expect(() =>
      reconcileMirror(kbRoot, join(TMP_HOME, 'Library', 'Application Support', 'NotAllowed'))
    ).toThrow(/dedicated subdirectory/)
  })

  it('rejects path traversal in the mirror path', () => {
    writeKb('a.md', 'x')
    expect(() =>
      reconcileMirror(kbRoot, `${TMP_HOME}/Documents/../Library/Application Support/Sneaky`)
    ).toThrow(/dedicated subdirectory/)
  })

  it('rejects the bare ~/Documents folder (would delete unrelated .md files)', () => {
    writeKb('a.md', 'x')
    expect(() => reconcileMirror(kbRoot, join(TMP_HOME, 'Documents'))).toThrow(
      /dedicated subdirectory/
    )
  })

  it('preserves source mtime so a second reconcile actually skips', () => {
    writeKb('a.md', 'unchanged content')
    const first = reconcileMirror(kbRoot, mirrorRoot)
    expect(first.copied).toBe(1)
    expect(first.skipped).toBe(0)
    // Re-run without touching source; the mirror file's mtime should
    // have been stamped to match the source so the second pass
    // recognises it as unchanged.
    const second = reconcileMirror(kbRoot, mirrorRoot)
    expect(second.copied).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('creates nested parent dirs on the mirror side', () => {
    writeKb('deep/nested/dir/note.md', 'x')
    reconcileMirror(kbRoot, mirrorRoot)
    expect(existsSync(join(mirrorRoot, 'deep', 'nested', 'dir', 'note.md'))).toBe(true)
  })
})

describe('applyMirrorChange', () => {
  let kbRoot: string
  let mirrorRoot: string

  beforeEach(() => {
    kbRoot = mkdtempSync(join(tmpdir(), 'compass-kb-'))
    mirrorRoot = join(TMP_HOME, 'Documents', 'Compass Notes')
    mkdirSync(mirrorRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(kbRoot, { recursive: true, force: true })
  })

  it('copies a newly added file', () => {
    const src = join(kbRoot, 'a.md')
    writeFileSync(src, 'hello', 'utf8')
    const r = applyMirrorChange('add', kbRoot, mirrorRoot, src)
    expect(r.kind).toBe('copied')
    expect(readFileSync(join(mirrorRoot, 'a.md'), 'utf8')).toBe('hello')
  })

  it('overwrites on change', () => {
    const src = join(kbRoot, 'a.md')
    writeFileSync(src, 'v1', 'utf8')
    applyMirrorChange('add', kbRoot, mirrorRoot, src)
    writeFileSync(src, 'v2', 'utf8')
    applyMirrorChange('change', kbRoot, mirrorRoot, src)
    expect(readFileSync(join(mirrorRoot, 'a.md'), 'utf8')).toBe('v2')
  })

  it('removes on unlink', () => {
    const src = join(kbRoot, 'a.md')
    writeFileSync(src, 'x', 'utf8')
    applyMirrorChange('add', kbRoot, mirrorRoot, src)
    rmSync(src)
    const r = applyMirrorChange('unlink', kbRoot, mirrorRoot, src)
    expect(r.kind).toBe('removed')
    expect(existsSync(join(mirrorRoot, 'a.md'))).toBe(false)
  })

  it('refuses to write outside an off-limits mirror root', () => {
    const src = join(kbRoot, 'a.md')
    writeFileSync(src, 'x', 'utf8')
    const r = applyMirrorChange('add', kbRoot, join(TMP_HOME, 'Library', 'NotAllowed'), src)
    expect(r.kind).toBe('noop')
  })

  it('ignores non-.md files', () => {
    const src = join(kbRoot, 'a.txt')
    writeFileSync(src, 'x', 'utf8')
    const r = applyMirrorChange('add', kbRoot, mirrorRoot, src)
    expect(r.kind).toBe('noop')
    expect(existsSync(join(mirrorRoot, 'a.txt'))).toBe(false)
  })

  it('refuses a source path outside kbRoot (symlink defense)', () => {
    const evil = join(TMP_HOME, 'outside.md')
    writeFileSync(evil, 'x', 'utf8')
    const r = applyMirrorChange('add', kbRoot, mirrorRoot, evil)
    expect(r.kind).toBe('noop')
  })

  it('refuses a sibling whose name shares a prefix with kbRoot (`kb-X-evil`)', () => {
    // Previously `sourceAbsPath.startsWith(kbRoot)` would admit
    // `${kbRoot}-evil/x.md` and produce a traversing relative path.
    // The fixed check uses path.relative + ".."-rejection.
    const evilBase = `${kbRoot}-evil`
    mkdirSync(evilBase, { recursive: true })
    const evil = join(evilBase, 'x.md')
    writeFileSync(evil, 'x', 'utf8')
    try {
      const r = applyMirrorChange('add', kbRoot, mirrorRoot, evil)
      expect(r.kind).toBe('noop')
      expect(existsSync(join(mirrorRoot, '..', 'x.md'))).toBe(false)
    } finally {
      rmSync(evilBase, { recursive: true, force: true })
    }
  })

  it('rejects an unnormalized mirror root with `..` segments', () => {
    const src = join(kbRoot, 'a.md')
    writeFileSync(src, 'x', 'utf8')
    const evil = `${TMP_HOME}/Documents/../Library/Sneaky`
    const r = applyMirrorChange('add', kbRoot, evil, src)
    expect(r.kind).toBe('noop')
  })

  it('accepts a tilde-prefixed mirror root (resolves at the boundary)', () => {
    const src = join(kbRoot, 'a.md')
    writeFileSync(src, 'hello', 'utf8')
    // Pass `~/Documents/Compass Notes` — should resolve and write
    // under the real TMP_HOME path, not create a literal `~` directory.
    const r = applyMirrorChange('add', kbRoot, '~/Documents/Compass Notes', src)
    expect(r.kind).toBe('copied')
    expect(existsSync(join(TMP_HOME, 'Documents', 'Compass Notes', 'a.md'))).toBe(true)
  })
})
