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

  it('falls back to name + connect date when the profile URL is blank', () => {
    // LinkedIn blanks the URL when a member limited visibility — the dedup key
    // must still be stable so re-imports don't duplicate.
    const text = [
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Carol,Lee,,carol@example.com,Initech,Designer,20 Feb 2025'
    ].join('\n')
    const out = LINKEDIN_RECOGNIZER.parse(file('Connections.csv', text))
    expect(out).toHaveLength(1)
    expect(out[0].naturalKey).toBe('Carol Lee|20 Feb 2025')
  })

  it('does not claim a non-LinkedIn CSV', () => {
    const f = file('misc.csv', 'when,event\n2026-02-01,Did a thing\n')
    expect(LINKEDIN_RECOGNIZER.detect(f)).toBe(false)
    expect(recognize(f)?.id).not.toBe('linkedin')
  })
})

import {
  LINKEDIN_ENDORSEMENTS_RECOGNIZER,
  LINKEDIN_INVITATIONS_RECOGNIZER,
  LINKEDIN_LEARNING_RECOGNIZER,
  LINKEDIN_MESSAGES_RECOGNIZER,
  LINKEDIN_POSITIONS_RECOGNIZER,
  LINKEDIN_RECOMMENDATIONS_GIVEN_RECOGNIZER,
  LINKEDIN_RECOMMENDATIONS_RECEIVED_RECOGNIZER
} from './linkedin'

describe('LinkedIn messages recognizer (content-light)', () => {
  const MSGS = [
    '"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"',
    '"c1","Chat with Joe","Joe","u/joe","Me","u/me","2026-06-24 22:17:33 UTC","","secret text 1","INBOX",""',
    '"c1","Chat with Joe","Me","u/me","Joe","u/joe","2026-06-24 23:00:00 UTC","","secret text 2","INBOX",""',
    '"c2","Chat with Ana","Ana","u/ana","Me","u/me","2026-06-23 09:00:00 UTC","","secret text 3","INBOX",""'
  ].join('\n')
  it('aggregates to per-day per-conversation counts and stores NO message text', () => {
    const f = file('messages.csv', MSGS)
    expect(recognize(f)?.id).toBe('linkedin-messages')
    const out = LINKEDIN_MESSAGES_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2) // (2026-06-24, c1) ×2 msgs + (2026-06-23, c2)
    const c1 = out.find((r) => r.title.includes('Chat with Joe'))
    expect(c1?.title).toBe('2 messages — Chat with Joe')
    expect(out.every((r) => !JSON.stringify(r).includes('secret text'))).toBe(true) // content never stored
  })
})

describe('LinkedIn positions / endorsements / invitations', () => {
  it('parses Positions into job records', () => {
    const csv =
      'Company Name,Title,Description,Location,Started On,Finished On\nMatillion,Forward Deployed Engineer,desc,Remote,Mar 2026,\n'
    const out = LINKEDIN_POSITIONS_RECOGNIZER.parse(file('Positions.csv', csv))
    expect(out[0]).toMatchObject({
      source: 'linkedin',
      type: 'job',
      title: 'Forward Deployed Engineer at Matillion'
    })
    expect(out[0].occurredAt).not.toBeNull()
  })
  it('parses Endorsements with the endorser + skill', () => {
    const csv =
      'Endorsement Date,Skill Name,Endorser First Name,Endorser Last Name,Endorser Public Url,Endorsement Status\n2023/03/01 19:52:23 UTC,SDLC,Carlos,Calderon,url,ACCEPTED\n'
    const out = LINKEDIN_ENDORSEMENTS_RECOGNIZER.parse(file('Endorsement_Received_Info.csv', csv))
    expect(out[0]).toMatchObject({
      type: 'endorsement',
      title: 'Carlos Calderon endorsed you for SDLC'
    })
  })
  it('labels invitations by direction', () => {
    const csv =
      'From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl\n' +
      'Me,Joe Herbert,"5/5/26, 5:30 PM",,OUTGOING,a,b\n' +
      'Ana Lopez,Me,"4/1/26, 1:00 PM",,INCOMING,c,d\n'
    const out = LINKEDIN_INVITATIONS_RECOGNIZER.parse(file('Invitations.csv', csv))
    expect(out.map((r) => r.title)).toEqual(['Invited Joe Herbert', 'Invitation from Ana Lopez'])
  })
})

describe('LinkedIn recommendations + learning', () => {
  const REC =
    'First Name,Last Name,Company,Job Title,Text,Creation Date,Status\nBarbara,Klein,X,Dev,"great",01/24/18, 03:00 PM,VISIBLE\n'
  it('splits received vs given by filename', () => {
    const recv = LINKEDIN_RECOMMENDATIONS_RECEIVED_RECOGNIZER.parse(
      file('Recommendations_Received.csv', REC)
    )
    const given = LINKEDIN_RECOMMENDATIONS_GIVEN_RECOGNIZER.parse(
      file('Recommendations_Given.csv', REC)
    )
    expect(recv[0].title).toBe('Recommendation from Barbara Klein')
    expect(given[0].title).toBe('Recommended Barbara Klein')
    // The given recognizer must NOT claim the received file.
    expect(
      LINKEDIN_RECOMMENDATIONS_GIVEN_RECOGNIZER.detect(file('Recommendations_Received.csv', REC))
    ).toBe(false)
  })
  it('dates Learning from the watched column, ignoring the literal "N/A" completed cell', () => {
    const csv =
      'Content Title,Content Type,Content Last Watched Date (if viewed),Content Completed At (if completed)\n' +
      '11 Tips for .NET 6,VIDEO,2022-09-18 02:10 UTC,N/A\n'
    const out = LINKEDIN_LEARNING_RECOGNIZER.parse(file('Learning.csv', csv))
    expect(out[0]).toMatchObject({ type: 'learning', title: '11 Tips for .NET 6' })
    expect(out[0].occurredAt).toBe(Date.parse('2022-09-18T02:10:00Z')) // seconds-less + N/A handled
  })
})
