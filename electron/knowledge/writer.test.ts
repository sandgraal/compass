/**
 * Tests for the knowledge-base file writer (Phase 6.2).
 *
 * `writer.ts` is pure `node:fs` + `node:path` — no DB, no electron — so the
 * cleanest harness is a real temp directory rather than an fs mock. That
 * exercises true filesystem semantics (the `.prev` snapshot, the
 * idempotent-seed behaviour, the empty-string-on-absent read).
 *
 * Coverage:
 *   - seedKnowledgeFiles: writes the starter set, does NOT overwrite a file
 *     the user has already edited (idempotent).
 *   - updateKnowledgeFile: writes content; snapshots the prior content to
 *     `<path>.prev` when the file already existed; no `.prev` on first write.
 *   - readPrevKnowledgeFile: returns the snapshot, or null when none exists.
 *   - readKnowledgeFile: returns content, or '' when the file is absent.
 *
 * Note: seedKnowledgeFiles assumes the category subdirs already exist (in
 * production main.ts mkdirs them before calling). The test mirrors that.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readKnowledgeFile,
  readPrevKnowledgeFile,
  seedKnowledgeFiles,
  updateKnowledgeFile
} from './writer'

// Subdirs main.ts creates before seeding — mirror them here.
const SUBDIRS = ['profile', 'work', 'calendar', 'inbox', 'drive', 'templates']

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compass-writer-'))
  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── seedKnowledgeFiles ───────────────────────────────────────────────────────

describe('seedKnowledgeFiles', () => {
  it('writes the starter files into the category subdirs', () => {
    seedKnowledgeFiles(dir)
    expect(existsSync(join(dir, 'profile/personal.md'))).toBe(true)
    expect(existsSync(join(dir, 'work/projects.md'))).toBe(true)
    expect(existsSync(join(dir, 'templates/daily.md'))).toBe(true)
    // Spot-check content actually landed.
    expect(readFileSync(join(dir, 'profile/personal.md'), 'utf8')).toContain('# Personal Profile')
  })

  it('does NOT overwrite a file the user has already edited (idempotent)', () => {
    const target = join(dir, 'profile/personal.md')
    writeFileSync(target, '# My own notes', 'utf8')
    seedKnowledgeFiles(dir)
    expect(readFileSync(target, 'utf8')).toBe('# My own notes')
  })

  it('is safe to run twice — second run leaves edited content intact', () => {
    seedKnowledgeFiles(dir)
    const edited = join(dir, 'work/projects.md')
    writeFileSync(edited, 'edited body', 'utf8')
    seedKnowledgeFiles(dir)
    expect(readFileSync(edited, 'utf8')).toBe('edited body')
  })
})

// ── updateKnowledgeFile + readPrevKnowledgeFile ──────────────────────────────

describe('updateKnowledgeFile', () => {
  it('writes content and creates no .prev on the first write', () => {
    updateKnowledgeFile(dir, 'profile/personal.md', 'first content')
    expect(readFileSync(join(dir, 'profile/personal.md'), 'utf8')).toBe('first content')
    expect(existsSync(join(dir, 'profile/personal.md.prev'))).toBe(false)
    expect(readPrevKnowledgeFile(dir, 'profile/personal.md')).toBeNull()
  })

  it('snapshots the prior content to .prev when the file already existed', () => {
    updateKnowledgeFile(dir, 'profile/personal.md', 'v1')
    updateKnowledgeFile(dir, 'profile/personal.md', 'v2')
    expect(readFileSync(join(dir, 'profile/personal.md'), 'utf8')).toBe('v2')
    expect(readPrevKnowledgeFile(dir, 'profile/personal.md')).toBe('v1')
  })

  it('keeps only the immediately-previous version in .prev', () => {
    updateKnowledgeFile(dir, 'profile/personal.md', 'v1')
    updateKnowledgeFile(dir, 'profile/personal.md', 'v2')
    updateKnowledgeFile(dir, 'profile/personal.md', 'v3')
    expect(readPrevKnowledgeFile(dir, 'profile/personal.md')).toBe('v2')
  })
})

// ── readKnowledgeFile ────────────────────────────────────────────────────────

describe('readKnowledgeFile', () => {
  it('returns the file content when present', () => {
    writeFileSync(join(dir, 'profile/personal.md'), 'hello', 'utf8')
    expect(readKnowledgeFile(dir, 'profile/personal.md')).toBe('hello')
  })

  it('returns empty string (not throw) when the file is absent', () => {
    expect(readKnowledgeFile(dir, 'profile/does-not-exist.md')).toBe('')
  })
})

// ── readPrevKnowledgeFile (absent case) ──────────────────────────────────────

describe('readPrevKnowledgeFile', () => {
  it('returns null when no snapshot exists', () => {
    expect(readPrevKnowledgeFile(dir, 'profile/personal.md')).toBeNull()
  })
})
