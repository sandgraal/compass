import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localYmd } from './dates.js'
import { type Proposal, appendProposal, buildProposal, makeProposal } from './proposals.js'

describe('buildProposal', () => {
  describe('compass_propose_task', () => {
    it('requires a non-empty title', () => {
      expect(buildProposal('compass_propose_task', {})).toEqual({ error: 'title is required' })
      expect(buildProposal('compass_propose_task', { title: '   ' })).toEqual({
        error: 'title is required'
      })
    })

    it('defaults to today on the daily list', () => {
      const r = buildProposal('compass_propose_task', { title: 'Call dentist' })
      expect(r).toEqual({
        type: 'task',
        payload: { title: 'Call dentist', listType: 'daily', listDate: localYmd() }
      })
    })

    it('keeps optional body/category and honors listType + valid listDate', () => {
      const r = buildProposal('compass_propose_task', {
        title: 'Plan Q3',
        body: 'rough outline',
        category: 'work',
        listType: 'monthly',
        listDate: '2026-05-23'
      })
      expect(r).toEqual({
        type: 'task',
        payload: {
          title: 'Plan Q3',
          listType: 'monthly',
          listDate: '2026-05-23',
          body: 'rough outline',
          category: 'work'
        }
      })
    })

    it('rejects an unsupported listType (e.g. the old "master")', () => {
      expect(buildProposal('compass_propose_task', { title: 'x', listType: 'master' })).toEqual({
        error: 'listType must be one of daily, weekly, monthly'
      })
    })

    it('rejects a malformed or impossible listDate instead of retargeting to today', () => {
      for (const listDate of ['05/23/2026', '2026-13-40', '2026-02-30', 'today']) {
        expect(buildProposal('compass_propose_task', { title: 'x', listDate })).toEqual({
          error: 'listDate must be a valid YYYY-MM-DD date'
        })
      }
    })
  })

  describe('compass_propose_note', () => {
    it('rejects traversal, absolute, Windows/UNC, and non-md paths', () => {
      for (const path of [
        '../escape.md',
        'a/../../escape.md',
        '/etc/passwd.md',
        'C:\\notes\\x.md',
        'c:/notes/x.md',
        '\\\\server\\share\\x.md',
        'notes\\x.md',
        'notes/x.txt',
        ''
      ]) {
        expect(buildProposal('compass_propose_note', { path, content: 'hi' })).toHaveProperty(
          'error'
        )
      }
    })

    it('requires content', () => {
      expect(buildProposal('compass_propose_note', { path: 'a.md', content: '  ' })).toEqual({
        error: 'content is required'
      })
    })

    it('accepts a relative .md path and defaults mode to create', () => {
      expect(
        buildProposal('compass_propose_note', { path: 'notes/idea.md', content: '# Idea' })
      ).toEqual({
        type: 'note',
        payload: { path: 'notes/idea.md', content: '# Idea', mode: 'create' }
      })
    })

    it('honors append mode', () => {
      const r = buildProposal('compass_propose_note', {
        path: 'log.md',
        content: 'line',
        mode: 'append'
      })
      expect(r).toMatchObject({ payload: { mode: 'append' } })
    })
  })

  describe('compass_propose_txn_tag', () => {
    it('requires a positive integer transactionId', () => {
      for (const transactionId of [undefined, 0, -3, 1.5, 'x']) {
        expect(
          buildProposal('compass_propose_txn_tag', { transactionId, taxTag: 't' })
        ).toHaveProperty('error')
      }
    })

    it('requires at least one of taxTag/category', () => {
      expect(buildProposal('compass_propose_txn_tag', { transactionId: 5 })).toEqual({
        error: 'provide at least one of taxTag or category'
      })
    })

    it('builds with a whitelisted taxTag and/or category', () => {
      expect(
        buildProposal('compass_propose_txn_tag', {
          transactionId: 5,
          taxTag: 'tax:charitable',
          category: 'Gifts'
        })
      ).toEqual({
        type: 'txn_tag',
        payload: { transactionId: 5, taxTag: 'tax:charitable', category: 'Gifts' }
      })
    })

    it('rejects a taxTag outside the allowed tax:* set', () => {
      const r = buildProposal('compass_propose_txn_tag', { transactionId: 5, taxTag: 'charity' })
      expect(r).toHaveProperty('error')
      expect((r as { error: string }).error).toMatch(/taxTag must be one of/)
    })

    it('still allows category-only proposals', () => {
      expect(
        buildProposal('compass_propose_txn_tag', { transactionId: 5, category: 'Gifts' })
      ).toEqual({ type: 'txn_tag', payload: { transactionId: 5, category: 'Gifts' } })
    })
  })

  describe('compass_propose_habit_check', () => {
    it('requires a positive integer habitId', () => {
      expect(buildProposal('compass_propose_habit_check', {})).toHaveProperty('error')
      expect(buildProposal('compass_propose_habit_check', { habitId: -1 })).toHaveProperty('error')
    })

    it('defaults date to today and completed to true', () => {
      expect(buildProposal('compass_propose_habit_check', { habitId: 2 })).toEqual({
        type: 'habit_check',
        payload: { habitId: 2, date: localYmd(), completed: true }
      })
    })

    it('honors explicit date and completed=false', () => {
      expect(
        buildProposal('compass_propose_habit_check', {
          habitId: 2,
          date: '2026-05-01',
          completed: false
        })
      ).toEqual({
        type: 'habit_check',
        payload: { habitId: 2, date: '2026-05-01', completed: false }
      })
    })

    it('rejects a non-boolean completed (no coercion of "false")', () => {
      for (const completed of ['false', 'true', 0, 1, null]) {
        expect(buildProposal('compass_propose_habit_check', { habitId: 2, completed })).toEqual({
          error: 'completed must be a boolean (true or false)'
        })
      }
    })

    it('rejects an impossible date', () => {
      expect(
        buildProposal('compass_propose_habit_check', { habitId: 2, date: '2026-02-30' })
      ).toEqual({ error: 'date must be a valid YYYY-MM-DD date' })
    })
  })

  it('rejects an unknown propose tool', () => {
    expect(buildProposal('compass_propose_unknown', {})).toHaveProperty('error')
  })
})

describe('makeProposal', () => {
  it('stamps id, ISO timestamp, pending status, and source', () => {
    const p = makeProposal('task', { title: 'x' })
    expect(p.type).toBe('task')
    expect(p.status).toBe('pending')
    expect(p.source).toBe('claude-mcp')
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => new Date(p.createdAt).toISOString()).not.toThrow()
    expect(new Date(p.createdAt).toISOString()).toBe(p.createdAt)
  })

  it('mints a unique id per call', () => {
    expect(makeProposal('note', {}).id).not.toBe(makeProposal('note', {}).id)
  })
})

describe('appendProposal', () => {
  let dir: string
  let inbox: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compass-inbox-'))
    inbox = join(dir, '.data', 'claude-inbox.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the inbox dir and appends one JSON line per proposal', () => {
    const a = makeProposal('task', { title: 'a' })
    const b = makeProposal('habit_check', { habitId: 1, date: '2026-05-23', completed: true })
    appendProposal(inbox, a)
    appendProposal(inbox, b)

    const lines = readFileSync(inbox, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l) as Proposal)
    expect(parsed[0]).toEqual(a)
    expect(parsed[1]).toEqual(b)
  })
})
