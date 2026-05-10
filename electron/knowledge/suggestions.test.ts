import { describe, expect, it, vi } from 'vitest'
import {
  type GitHubInputItem,
  type GmailInputMessage,
  type OllamaSyncContext,
  extractContactsFromGithub,
  extractContactsFromGmail,
  extractFactsViaOllama,
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

// ── extractFactsViaOllama ─────────────────────────────────────────────────────

describe('extractFactsViaOllama', () => {
  // Minimal context used by most tests
  function makeCtx(overrides: Partial<OllamaSyncContext> = {}): OllamaSyncContext {
    return {
      gmailMessages: [
        {
          id: 'm1',
          threadId: 't1',
          subject: 'Q3 proposal',
          from: 'Jane Doe <jane@acme.com>',
          date: new Date().toISOString()
        }
      ],
      githubItems: [],
      existingRelationships: '',
      existingEmployers: '',
      model: 'llama3.2:3b',
      ...overrides
    }
  }

  it('returns [] when Ollama is unavailable', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: false }),
      runOllamaPrompt: vi.fn()
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(0)
    expect(deps.runOllamaPrompt).not.toHaveBeenCalled()
  })

  it('returns [] when there is no data to prompt with', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn()
    }
    // No gmail messages or github items
    const results = await extractFactsViaOllama(
      makeCtx({ gmailMessages: [], githubItems: [] }),
      deps
    )
    expect(results).toHaveLength(0)
    expect(deps.runOllamaPrompt).not.toHaveBeenCalled()
  })

  it('parses a well-formed JSON response correctly', async () => {
    const validResponse = JSON.stringify([
      { kind: 'contact', name: 'Jane Doe', detail: 'Product Manager', source: 'gmail' }
    ])
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(validResponse)
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(1)
    expect(results[0].source).toBe('ollama:gmail')
    expect(results[0].kind).toBe('contact')
    expect(results[0].proposedContent).toContain('Jane Doe')
    expect(results[0].proposedContent).toContain('Product Manager')
    expect(results[0].targetPath).toBe('profile/relationships.md')
  })

  it('parses employer facts and sets the correct targetPath', async () => {
    const validResponse = JSON.stringify([
      { kind: 'employer', name: 'Acme Corp', detail: 'SaaS startup', source: 'gmail' }
    ])
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(validResponse)
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(1)
    expect(results[0].targetPath).toBe('work/employers.md')
    expect(results[0].source).toBe('ollama:gmail')
  })

  it('discards malformed JSON entirely', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue('Here are the results: { broken json ]')
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(0)
  })

  it('discards a response with no JSON array', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue('I found no relevant facts in the data provided.')
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(0)
  })

  it('discards facts with an invalid kind', async () => {
    const badResponse = JSON.stringify([{ kind: 'pet', name: 'Fluffy', source: 'gmail' }])
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(badResponse)
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(0)
  })

  it('discards facts with an invalid source field', async () => {
    const badResponse = JSON.stringify([{ kind: 'contact', name: 'Bob', source: 'linkedin' }])
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(badResponse)
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(0)
  })

  it('does not propose a fact already present in existingRelationships', async () => {
    const validResponse = JSON.stringify([
      { kind: 'contact', name: 'Jane Doe', detail: 'Colleague', source: 'gmail' }
    ])
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(validResponse)
    }
    const results = await extractFactsViaOllama(
      makeCtx({ existingRelationships: '| Jane Doe | Colleague | jane@acme.com |' }),
      deps
    )
    // Already mentioned — should be filtered out
    expect(results).toHaveLength(0)
  })

  it('does not propose an employer already present in existingEmployers', async () => {
    const validResponse = JSON.stringify([{ kind: 'employer', name: 'Acme Corp', source: 'gmail' }])
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(validResponse)
    }
    const results = await extractFactsViaOllama(
      makeCtx({ existingEmployers: 'Acme Corp is my current employer' }),
      deps
    )
    expect(results).toHaveLength(0)
  })

  it('returns [] when runOllamaPrompt throws', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockRejectedValue(new Error('connection refused'))
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(0)
  })

  it('strips prose surrounding the JSON array', async () => {
    const responseWithProse = `Sure! Here are the facts I found:\n[{"kind":"contact","name":"Alice","source":"github"}]\nHope that helps!`
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(responseWithProse)
    }
    const results = await extractFactsViaOllama(
      makeCtx({
        githubItems: [
          {
            id: 1,
            html_url: 'https://github.com/org/repo/issues/1',
            type: 'issue',
            repo: 'org/repo',
            user: { login: 'alice' },
            assignee: null,
            labels: []
          }
        ]
      }),
      deps
    )
    expect(results).toHaveLength(1)
    expect(results[0].proposedContent).toContain('Alice')
    expect(results[0].source).toBe('ollama:github')
  })

  it('uses sender display names only in prompt data when from header is bare email', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue('[]')
    }
    await extractFactsViaOllama(
      makeCtx({
        gmailMessages: [
          {
            id: 'm-email',
            threadId: 't-email',
            subject: 'Need follow up',
            from: 'bare.sender@example.com'
          }
        ]
      }),
      deps
    )
    const prompt = deps.runOllamaPrompt.mock.calls[0]?.[1] as string
    expect(prompt).toContain('(no display name)')
    expect(prompt).not.toContain('bare.sender@example.com')
  })

  it('includes GitHub title + repo in prompt data', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue('[]')
    }
    await extractFactsViaOllama(
      makeCtx({
        gmailMessages: [],
        githubItems: [
          {
            id: 99,
            html_url: 'https://github.com/org/repo/issues/99',
            type: 'issue',
            repo: 'org/repo',
            title: 'Fix flaky knowledge extraction test',
            user: { login: 'octocat' },
            assignee: null,
            labels: []
          }
        ]
      }),
      deps
    )
    const prompt = deps.runOllamaPrompt.mock.calls[0]?.[1] as string
    expect(prompt).toContain('org/repo')
    expect(prompt).toContain('Title: Fix flaky knowledge extraction test')
    expect(prompt).not.toContain('author:')
  })

  it('sanitizes markdown-breaking characters in model output', async () => {
    const deps = {
      detectOllama: vi.fn().mockResolvedValue({ available: true }),
      runOllamaPrompt: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: 'contact',
            name: 'A|lice\n<script>',
            detail: 'Lead|\nEng <b>',
            source: 'gmail'
          }
        ])
      )
    }
    const results = await extractFactsViaOllama(makeCtx(), deps)
    expect(results).toHaveLength(1)
    expect(results[0].sourceId).toBe('gmail:contact:a lice script')
    expect(results[0].proposedContent).toContain('| A lice script | Lead Eng b |')
    expect(results[0].proposedContent).not.toContain('<')
    expect(results[0].proposedContent).not.toContain('|lice')
  })
})
