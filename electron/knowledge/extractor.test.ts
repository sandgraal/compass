/**
 * Tests for the knowledge extractor markdown builders (Phase 6.2).
 *
 * Each `update*Knowledge` function turns a list of synced records into a
 * markdown document and writes it via `updateKnowledgeFile`. They're pure
 * string-builders with no DB/network, so we mock `./writer` to capture the
 * (path, content) that WOULD be written and assert on the generated markdown
 * + the target path.
 *
 * Coverage focuses on the logic, not the prose:
 *   - empty-input early returns (calendar/gmail/drive write nothing; GitHub
 *     still writes its "none" sections)
 *   - calendar sorting by start time + all-day vs timed formatting
 *   - gmail truncation (subject/from/snippet) + angle-bracket address strip
 *   - drive pipe-escaping + the 30-row cap
 *   - github issue-vs-PR partitioning + repo fallback from html_url
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above the module body, so anything they close
// over must be created with vi.hoisted (which runs before the mocks).
const { KNOWLEDGE_DIR, writes } = vi.hoisted(() => ({
  KNOWLEDGE_DIR: '/fake/knowledge',
  writes: [] as Array<{ dir: string; relPath: string; content: string }>
}))
vi.mock('../paths', () => ({ KNOWLEDGE_DIR }))
vi.mock('./writer', () => ({
  updateKnowledgeFile: (dir: string, relPath: string, content: string) => {
    writes.push({ dir, relPath, content })
  }
}))

import {
  updateCalendarKnowledge,
  updateDriveKnowledge,
  updateGitHubKnowledge,
  updateGmailKnowledge
} from './extractor'

function lastWrite() {
  return writes[writes.length - 1]
}

beforeEach(() => {
  writes.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

// ── calendar ─────────────────────────────────────────────────────────────────

describe('updateCalendarKnowledge', () => {
  it('writes nothing for an empty event list', async () => {
    await updateCalendarKnowledge([])
    expect(writes).toHaveLength(0)
  })

  it('sorts events by start time and targets calendar/upcoming.md', async () => {
    await updateCalendarKnowledge([
      { id: 'b', summary: 'Later', start: { dateTime: '2026-06-02T10:00:00Z' } },
      { id: 'a', summary: 'Earlier', start: { dateTime: '2026-06-01T09:00:00Z' } }
    ])
    const w = lastWrite()
    expect(w.dir).toBe(KNOWLEDGE_DIR)
    expect(w.relPath).toBe('calendar/upcoming.md')
    expect(w.content.indexOf('Earlier')).toBeLessThan(w.content.indexOf('Later'))
  })

  it('labels a date-only event as All day and a dateTime event with a time', async () => {
    await updateCalendarKnowledge([{ id: 'd', summary: 'Holiday', start: { date: '2026-07-04' } }])
    expect(lastWrite().content).toContain('**Time:** All day')
  })
})

// ── gmail ────────────────────────────────────────────────────────────────────

describe('updateGmailKnowledge', () => {
  it('writes nothing for an empty message list', async () => {
    await updateGmailKnowledge([])
    expect(writes).toHaveLength(0)
  })

  it('strips the angle-bracket address and truncates long fields', async () => {
    await updateGmailKnowledge([
      {
        id: '1',
        threadId: 't',
        subject: 'S'.repeat(100),
        from: 'Jane Doe <jane@example.com>',
        snippet: 'x'.repeat(200)
      }
    ])
    const c = lastWrite().content
    expect(lastWrite().relPath).toBe('inbox/action-items.md')
    expect(c).toContain('Jane Doe')
    expect(c).not.toContain('jane@example.com') // <...> stripped
    // subject capped at 70, snippet at 100
    expect(c).toContain(`**Preview:** ${'x'.repeat(100)}`)
    expect(c).not.toContain('x'.repeat(101))
  })
})

// ── drive ────────────────────────────────────────────────────────────────────

describe('updateDriveKnowledge', () => {
  it('writes nothing for an empty file list', async () => {
    await updateDriveKnowledge([])
    expect(writes).toHaveLength(0)
  })

  it('escapes pipes in names and caps the table at 30 rows', async () => {
    const files = Array.from({ length: 35 }, (_, i) => ({
      id: String(i),
      name: i === 0 ? 'a|b|c' : `file-${i}`
    }))
    await updateDriveKnowledge(files)
    const c = lastWrite().content
    expect(lastWrite().relPath).toBe('drive/index.md')
    expect(c).toContain('a\\|b\\|c')
    // 30-row cap: file-30..34 should be excluded
    expect(c).toContain('file-29')
    expect(c).not.toContain('file-30')
  })
})

// ── github ───────────────────────────────────────────────────────────────────

describe('updateGitHubKnowledge', () => {
  it('always writes (even empty) with the "none" placeholders', async () => {
    await updateGitHubKnowledge([])
    const c = lastWrite().content
    expect(lastWrite().relPath).toBe('work/github-summary.md')
    expect(c).toContain('_No open issues assigned._')
    expect(c).toContain('_No open pull requests._')
  })

  it('partitions issues vs PRs and only includes open ones', async () => {
    await updateGitHubKnowledge([
      { id: 1, title: 'Open issue', html_url: 'https://github.com/o/r/issues/1', state: 'open' },
      {
        id: 2,
        title: 'A PR',
        html_url: 'https://github.com/o/r/pull/2',
        state: 'open',
        pull_request: {}
      },
      { id: 3, title: 'Closed issue', html_url: 'https://github.com/o/r/issues/3', state: 'closed' }
    ])
    const c = lastWrite().content
    const issuesIdx = c.indexOf('## Open Issues Assigned to Me')
    const prsIdx = c.indexOf('## Open Pull Requests')
    expect(c).toContain('Open issue')
    expect(c).toContain('A PR')
    expect(c).not.toContain('Closed issue')
    // "A PR" belongs under the PR heading, not the issues heading.
    expect(c.indexOf('A PR')).toBeGreaterThan(prsIdx)
    // "Open issue" belongs under the issues heading.
    expect(c.indexOf('Open issue')).toBeGreaterThan(issuesIdx)
    expect(c.indexOf('Open issue')).toBeLessThan(prsIdx)
  })

  it('derives the repo slug from html_url when repository is absent', async () => {
    await updateGitHubKnowledge([
      { id: 1, title: 'T', html_url: 'https://github.com/acme/widgets/issues/9', state: 'open' }
    ])
    expect(lastWrite().content).toContain('`acme/widgets`')
  })
})
