/**
 * Tests for the mbox email-archive parser (Phase 10.4). Pure — lines are injected,
 * so no filesystem or Electron.
 */

import { describe, expect, it } from 'vitest'
import { decodeMimeWords, parseMbox } from './mbox'

async function* gen(arr: string[]): AsyncGenerator<string> {
  for (const l of arr) yield l
}

const MBOX = [
  'From 111@mx Mon Jan 02 08:00:00 +0000 2026',
  'Date: Mon, 2 Jan 2026 08:00:00 +0000',
  'From: Alice <alice@example.com>',
  'Subject: Hello',
  ' world', // RFC 5322 folded continuation → "Hello world"
  'Message-ID: <msg-1@example.com>',
  '',
  'Body of message one — never stored.',
  '',
  'From the team, no four-digit year so NOT a separator', // must not split the mailbox
  '',
  'From 222@mx Tue Jan 03 09:30:00 +0000 2026',
  'Date: Tue, 3 Jan 2026 09:30:00 +0000',
  'From: Bob <bob@example.com>',
  'Subject: =?UTF-8?B?w6lsw6lnYW50?=', // "élégant"
  'Message-ID: <msg-2@example.com>',
  '',
  'Body of message two — never stored.'
]

describe('decodeMimeWords', () => {
  it('decodes B and Q encoded-words', () => {
    expect(decodeMimeWords('=?UTF-8?B?SGVsbG8=?=')).toBe('Hello')
    expect(decodeMimeWords('=?UTF-8?Q?H=C3=A9llo?=')).toBe('Héllo')
    expect(decodeMimeWords('plain subject')).toBe('plain subject')
  })
})

describe('parseMbox', () => {
  it('emits one record per message from headers only', async () => {
    const recs = await parseMbox('x.mbox', gen(MBOX))
    expect(recs).toHaveLength(2)

    expect(recs[0]).toMatchObject({
      source: 'email',
      type: 'email',
      title: 'Hello world', // folded
      body: 'Alice <alice@example.com>',
      naturalKey: '<msg-1@example.com>'
    })
    expect(recs[0].occurredAt).toBe(Date.parse('Mon, 2 Jan 2026 08:00:00 +0000'))

    expect(recs[1].title).toBe('élégant') // MIME-decoded subject
    expect(recs[1].naturalKey).toBe('<msg-2@example.com>')
    expect(recs.every((r) => r.source === 'email')).toBe(true)
  })

  it('never stores the message body', async () => {
    const recs = await parseMbox('x.mbox', gen(MBOX))
    expect(JSON.stringify(recs)).not.toContain('never stored')
  })

  it('produces stable dedup keys across re-parses', async () => {
    const keys = (rs: Awaited<ReturnType<typeof parseMbox>>) => rs.map((r) => r.naturalKey)
    expect(keys(await parseMbox('x', gen(MBOX)))).toEqual(keys(await parseMbox('x', gen(MBOX))))
  })

  it('falls back to a composite key when Message-ID is absent', async () => {
    const recs = await parseMbox(
      'x',
      gen([
        'From a@b Wed Jan 01 00:00:00 +0000 2025',
        'Date: Wed, 1 Jan 2025 00:00:00 +0000',
        'From: nobody@example.com',
        'Subject: keyless',
        ''
      ])
    )
    expect(recs).toHaveLength(1)
    expect(recs[0].naturalKey).toContain('keyless')
  })
})
