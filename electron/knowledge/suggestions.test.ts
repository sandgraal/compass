import { describe, expect, it } from 'vitest'
import {
  type CalendarInputEvent,
  type GitHubInputItem,
  type GmailInputMessage,
  extractContactsFromCalendar,
  extractContactsFromGithub,
  extractContactsFromGmail,
  extractOrgsFromGmail
} from './suggestions'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const THIRTY_DAYS_AGO = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString()

function makeGmailMsg(
  overrides: Partial<GmailInputMessage> & Pick<GmailInputMessage, 'from'>
): GmailInputMessage {
  return {
    id: 'msg1',
    threadId: 'thread1',
    subject: 'Hello',
    snippet: 'Hey there',
    date: THIRTY_DAYS_AGO,
    ...overrides
  }
}

// ── extractContactsFromGmail ──────────────────────────────────────────────────

describe('extractContactsFromGmail', () => {
  it('proposes a contact when a display-name appears >= 2 times', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Alice Smith <alice@acme.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Alice Smith <alice@acme.com>' })
    ]
    const results = extractContactsFromGmail(messages, '')
    expect(results).toHaveLength(1)
    expect(results[0].proposedContent).toContain('Alice Smith')
    expect(results[0].proposedContent).toContain('alice@acme.com')
    expect(results[0].targetPath).toBe('profile/relationships.md')
    expect(results[0].kind).toBe('contact')
    expect(results[0].source).toBe('gmail')
  })

  it('does NOT propose a contact when they appear only once', () => {
    const messages: GmailInputMessage[] = [makeGmailMsg({ from: 'Bob Jones <bob@startup.io>' })]
    expect(extractContactsFromGmail(messages, '')).toHaveLength(0)
  })

  it('skips contacts already mentioned in the relationships file', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Carol White <carol@corp.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Carol White <carol@corp.com>' })
    ]
    const existing = '| Carol White | Friend | carol@corp.com |'
    expect(extractContactsFromGmail(messages, existing)).toHaveLength(0)
  })

  it('skips gmail.com and other free-mail domains', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Dave <dave@gmail.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Dave <dave@gmail.com>' })
    ]
    expect(extractContactsFromGmail(messages, '')).toHaveLength(0)
  })

  it('skips noreply senders', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Notifications <noreply@github.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Notifications <noreply@github.com>' })
    ]
    expect(extractContactsFromGmail(messages, '')).toHaveLength(0)
  })

  it('returns multiple distinct contacts', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Eve Adams <eve@foo.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Eve Adams <eve@foo.com>' }),
      makeGmailMsg({ id: 'm3', threadId: 't3', from: 'Frank Bar <frank@bar.io>' }),
      makeGmailMsg({ id: 'm4', threadId: 't4', from: 'Frank Bar <frank@bar.io>' })
    ]
    const results = extractContactsFromGmail(messages, '')
    expect(results).toHaveLength(2)
  })
})

// ── extractOrgsFromGmail ──────────────────────────────────────────────────────

describe('extractOrgsFromGmail', () => {
  it('proposes an org when a domain appears >= 3 times', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Alice <alice@acme.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Bob <bob@acme.com>' }),
      makeGmailMsg({ id: 'm3', threadId: 't3', from: 'Carol <carol@acme.com>' })
    ]
    const results = extractOrgsFromGmail(messages, '')
    expect(results).toHaveLength(1)
    expect(results[0].proposedContent).toContain('Acme')
    expect(results[0].targetPath).toBe('work/employers.md')
    expect(results[0].kind).toBe('employer')
  })

  it('does NOT propose when domain appears fewer than 3 times', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'Alice <alice@raredomain.io>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'Bob <bob@raredomain.io>' })
    ]
    expect(extractOrgsFromGmail(messages, '')).toHaveLength(0)
  })

  it('skips domains already mentioned in employers file', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'A <a@bigcorp.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'B <b@bigcorp.com>' }),
      makeGmailMsg({ id: 'm3', threadId: 't3', from: 'C <c@bigcorp.com>' })
    ]
    const existing = 'bigcorp.com is my employer'
    expect(extractOrgsFromGmail(messages, existing)).toHaveLength(0)
  })

  it('skips free-mail domains', () => {
    const messages: GmailInputMessage[] = [
      makeGmailMsg({ id: 'm1', threadId: 't1', from: 'A <a@gmail.com>' }),
      makeGmailMsg({ id: 'm2', threadId: 't2', from: 'B <b@gmail.com>' }),
      makeGmailMsg({ id: 'm3', threadId: 't3', from: 'C <c@gmail.com>' })
    ]
    expect(extractOrgsFromGmail(messages, '')).toHaveLength(0)
  })
})

// ── extractContactsFromCalendar ───────────────────────────────────────────────

describe('extractContactsFromCalendar', () => {
  const RECENT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5 days ago

  function makeEvent(
    overrides: Partial<CalendarInputEvent> & Pick<CalendarInputEvent, 'externalId'>
  ): CalendarInputEvent {
    return {
      title: 'Team Sync',
      description: null,
      startAt: RECENT,
      ...overrides
    }
  }

  it('does NOT propose a contact when they appear in only one event', () => {
    const events = [
      makeEvent({
        externalId: 'ev1',
        description: 'Organizer: Alice Smith <alice@acme.com>'
      })
    ]
    expect(extractContactsFromCalendar(events, '')).toHaveLength(0)
  })

  it('proposes a contact when the same email appears in >= 2 events', () => {
    const events = [
      makeEvent({
        externalId: 'ev1',
        description: 'Alice Smith <alice@acme.com> will present'
      }),
      makeEvent({
        externalId: 'ev2',
        description: 'Attendees: Alice Smith <alice@acme.com>'
      })
    ]
    const results = extractContactsFromCalendar(events, '')
    expect(results).toHaveLength(1)
    expect(results[0].proposedContent).toContain('Alice Smith')
    expect(results[0].proposedContent).toContain('alice@acme.com')
    expect(results[0].targetPath).toBe('profile/relationships.md')
    expect(results[0].kind).toBe('contact')
    expect(results[0].source).toBe('calendar')
  })

  it('does NOT count duplicate mentions inside one event as multiple events', () => {
    const events = [
      makeEvent({
        externalId: 'ev1',
        description: 'Alice <alice@acme.com> and again Alice <alice@acme.com>'
      })
    ]
    expect(extractContactsFromCalendar(events, '')).toHaveLength(0)
  })

  it('does NOT propose when the contact is already in relationships.md', () => {
    const events = [
      makeEvent({
        externalId: 'ev1',
        description: 'Bob Jones <bob@startup.io>'
      }),
      makeEvent({
        externalId: 'ev2',
        description: 'Bob Jones <bob@startup.io> joining remotely'
      })
    ]
    const existing = '| Bob Jones | Colleague | bob@startup.io |'
    expect(extractContactsFromCalendar(events, existing)).toHaveLength(0)
  })

  it('skips events older than 30 days', () => {
    const OLD = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    const events = [
      makeEvent({ externalId: 'ev1', description: 'carol@work.com', startAt: OLD }),
      makeEvent({ externalId: 'ev2', description: 'carol@work.com', startAt: OLD })
    ]
    expect(extractContactsFromCalendar(events, '')).toHaveLength(0)
  })

  it('skips noreply and automated email addresses', () => {
    const events = [
      makeEvent({ externalId: 'ev1', description: 'noreply@calendar.google.com' }),
      makeEvent({ externalId: 'ev2', description: 'noreply@calendar.google.com' })
    ]
    expect(extractContactsFromCalendar(events, '')).toHaveLength(0)
  })

  it('skips events with no description', () => {
    const events = [
      makeEvent({ externalId: 'ev1', description: null }),
      makeEvent({ externalId: 'ev2', description: undefined })
    ]
    expect(extractContactsFromCalendar(events, '')).toHaveLength(0)
  })

  it('includes context with event count', () => {
    const events = [
      makeEvent({ externalId: 'ev1', description: 'dave@partner.com' }),
      makeEvent({ externalId: 'ev2', description: 'dave@partner.com' }),
      makeEvent({ externalId: 'ev3', description: 'dave@partner.com' })
    ]
    const results = extractContactsFromCalendar(events, '')
    expect(results[0].context).toContain('3 calendar event')
  })
})

// ── extractContactsFromGithub ─────────────────────────────────────────────────

describe('extractContactsFromGithub', () => {
  function makeIssue(overrides: Partial<GitHubInputItem>): GitHubInputItem {
    return {
      id: 1,
      html_url: 'https://github.com/org/repo/issues/1',
      type: 'issue',
      repo: 'org/repo',
      assignee: null,
      user: null,
      labels: [],
      ...overrides
    }
  }

  it('proposes a contact for an assignee not yet in relationships', () => {
    const items = [makeIssue({ id: 10, assignee: { login: 'octocat' } })]
    const results = extractContactsFromGithub(items, '')
    expect(results).toHaveLength(1)
    expect(results[0].proposedContent).toContain('octocat')
    expect(results[0].proposedContent).toContain('https://github.com/octocat')
    expect(results[0].kind).toBe('contact')
    expect(results[0].source).toBe('github')
  })

  it('proposes a contact for the issue author (user field)', () => {
    const items = [makeIssue({ id: 11, user: { login: 'alice-dev' } })]
    const results = extractContactsFromGithub(items, '')
    expect(results).toHaveLength(1)
    expect(results[0].proposedContent).toContain('alice-dev')
  })

  it('skips logins already in the relationships file', () => {
    const items = [makeIssue({ id: 12, assignee: { login: 'known-user' } })]
    const existing = '| known-user | GitHub | https://github.com/known-user |'
    expect(extractContactsFromGithub(items, existing)).toHaveLength(0)
  })

  it('skips bot accounts', () => {
    const items = [
      makeIssue({ id: 13, assignee: { login: 'dependabot[bot]' } }),
      makeIssue({ id: 14, user: { login: 'renovate[bot]' } })
    ]
    expect(extractContactsFromGithub(items, '')).toHaveLength(0)
  })

  it('deduplicates the same login across multiple items', () => {
    const items = [
      makeIssue({ id: 15, assignee: { login: 'repeated-user' } }),
      makeIssue({ id: 16, assignee: { login: 'repeated-user' } })
    ]
    const results = extractContactsFromGithub(items, '')
    expect(results).toHaveLength(1)
    expect(results[0].context).toContain('2 issue')
  })

  it('returns empty array when there are no items', () => {
    expect(extractContactsFromGithub([], '')).toHaveLength(0)
  })
})
