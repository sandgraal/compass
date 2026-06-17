/**
 * Tests for the LinkedIn connections recognizer (Phase 10). Covers the "Notes:"
 * preamble skipping, the name title + role body, the Connected-On date, the
 * profile-URL dedup key, and detection ahead of the generic catch-all.
 */

import { describe, expect, it } from 'vitest'
import { LINKEDIN_RECOGNIZER } from './linkedin'
import { type RecognizerFile, recognize } from './recognizers'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

// A LinkedIn export: a "Notes:" disclaimer + blank line wrap the real header.
const LINKEDIN = [
  'Notes:',
  '"When exporting your connection data, some fields may be missing if the member limited visibility."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'John,Doe,https://www.linkedin.com/in/johndoe,,Acme Inc,Software Engineer,15 Jan 2026',
  'Jane,Smith,https://www.linkedin.com/in/janesmith,jane@example.com,Globex,Product Manager,03 Mar 2024'
].join('\n')

describe('LinkedIn connections recognizer', () => {
  it('skips the Notes preamble and emits one record per connection', () => {
    const f = file('Connections.csv', LINKEDIN)
    expect(recognize(f)?.id).toBe('linkedin') // claims it ahead of the generic catch-all

    const out = LINKEDIN_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.source === 'linkedin' && r.type === 'connection')).toBe(true)

    const john = out.find((r) => r.title === 'Connected with John Doe')
    expect(john?.body).toBe('Software Engineer at Acme Inc')
    expect(john?.naturalKey).toBe('https://www.linkedin.com/in/johndoe') // profile URL
    expect(john?.occurredAt).toBe(Date.parse('15 Jan 2026'))
  })

  it('does not claim a non-LinkedIn CSV', () => {
    const f = file('misc.csv', 'when,event\n2026-02-01,Did a thing\n')
    expect(LINKEDIN_RECOGNIZER.detect(f)).toBe(false)
    expect(recognize(f)?.id).not.toBe('linkedin')
  })
})
