/**
 * Name-extraction and person/merchant-classification helpers shared by the
 * cross-reference engine and contact dedupe.
 */

import { describe, expect, it } from 'vitest'
import {
  extractPersonName,
  humanizeHandle,
  isAutomatedSender,
  isLikelyPerson,
  normalizeName,
  parseEmailSender
} from './people'

describe('humanizeHandle', () => {
  it('title-cases a delimited multi-part handle', () => {
    expect(humanizeHandle('jane-doe')).toBe('Jane Doe')
    expect(humanizeHandle('bob.smith')).toBe('Bob Smith')
    expect(humanizeHandle('ana_maria')).toBe('Ana Maria')
  })

  it('returns null for a single token or a handle with digits', () => {
    expect(humanizeHandle('sandgraal')).toBeNull()
    expect(humanizeHandle('user123-x')).toBeNull()
  })
})

describe('isAutomatedSender', () => {
  it('flags the real-world automated senders (no-reply, role alias, bulk subdomain, "via")', () => {
    for (const from of [
      'Google <no-reply@accounts.google.com>',
      'Google Alerts <googlealerts-noreply@google.com>', // mid-local "noreply"
      'Snowflake via LinkedIn <newsletters-noreply@linkedin.com>', // "via" + noreply
      'ResortPass <hello@hello.resortpass.com>',
      'American Express <americanexpress@member.americanexpress.com>', // member. subdomain
      'Linear <security@updates.linear.app>',
      'FLUENT <Info@getfluent.com>'
    ]) {
      expect(isAutomatedSender(from), from).toBe(true)
    }
  })

  it('does NOT flag a real person sending from a personal address', () => {
    expect(isAutomatedSender('Jane Doe <jane@example.com>')).toBe(false)
    expect(isAutomatedSender('jane.doe@gmail.com')).toBe(false)
  })

  it('matches automation tokens on segment/prefix boundaries, not substrings', () => {
    expect(isAutomatedSender('no-reply@x.com')).toBe(true) // delimited no-reply
    expect(isAutomatedSender('honoreply@x.com')).toBe(false) // "noreply" mid-token, not a prefix
    expect(isAutomatedSender('mailinfo@x.com')).toBe(false) // "info"/"mail" as a substring, not a segment
  })
})

describe('parseEmailSender', () => {
  it('returns the display name from a "Name <addr>" header', () => {
    expect(parseEmailSender('Jane Doe <jane@example.com>')).toBe('Jane Doe')
    expect(parseEmailSender('"Doe, Jane" <jane@x.com>')).toBe('Doe, Jane')
  })

  it('humanizes a first.last / first_last bare address', () => {
    expect(parseEmailSender('jane.doe@example.com')).toBe('Jane Doe')
    expect(parseEmailSender('bob_smith@x.com')).toBe('Bob Smith')
  })

  it('returns null for a single-token local part (noreply/billing)', () => {
    expect(parseEmailSender('noreply@github.com')).toBeNull()
    expect(parseEmailSender('billing@stripe.com')).toBeNull()
    expect(parseEmailSender('')).toBeNull()
  })
})

describe('extractPersonName', () => {
  it('pulls the person from each people-bearing title', () => {
    expect(extractPersonName('linkedin', 'connection', 'Connected with John Doe')).toBe('John Doe')
    expect(extractPersonName('linkedin', 'invitation', 'Invited Ana Lopez')).toBe('Ana Lopez')
    expect(extractPersonName('linkedin', 'invitation', 'Invitation from Sam Kim')).toBe('Sam Kim')
    expect(extractPersonName('linkedin', 'recommendation', 'Recommended Barbara Klein')).toBe(
      'Barbara Klein'
    )
    expect(extractPersonName('linkedin', 'recommendation', 'Recommendation from Lee Park')).toBe(
      'Lee Park'
    )
    expect(
      extractPersonName('linkedin', 'endorsement', 'Carlos Calderon endorsed you for SDLC')
    ).toBe('Carlos Calderon')
    expect(extractPersonName('facebook', 'connection', 'Became friends with Maria Cruz')).toBe(
      'Maria Cruz'
    )
  })

  it('returns null for records that do not name a person', () => {
    expect(extractPersonName('linkedin', 'endorsement', 'Endorsed for Leadership')).toBeNull()
    expect(extractPersonName('linkedin', 'job', 'Engineer at Acme')).toBeNull()
    expect(extractPersonName('netflix', 'watch', 'The Matrix')).toBeNull()
    expect(extractPersonName('facebook', 'post', 'Became a fan of something')).toBeNull()
  })

  it('pulls conversation partners from message titles (with / em-dash / "Chat with")', () => {
    expect(extractPersonName('imessage', 'messages', '23 messages with Alice')).toBe('Alice')
    expect(extractPersonName('facebook', 'messages', '5 messages with Maria Cruz')).toBe(
      'Maria Cruz'
    )
    expect(extractPersonName('linkedin', 'messages', '7 messages — Chat with Joe Herbert')).toBe(
      'Joe Herbert'
    )
    // phone-number conversations + group threads are dropped
    expect(extractPersonName('imessage', 'messages', '4 messages with +14155551234')).toBeNull()
    expect(extractPersonName('imessage', 'messages', '9 messages with Alice, Bob')).toBeNull()
  })

  it('keeps PayPal payees that are people, drops merchants + the generic fallback', () => {
    expect(extractPersonName('paypal', 'payment', 'Jane Doe')).toBe('Jane Doe')
    expect(extractPersonName('paypal', 'payment', 'Netflix')).toBeNull() // known merchant
    expect(extractPersonName('paypal', 'payment', 'ACME LLC')).toBeNull() // corp suffix
    expect(extractPersonName('paypal', 'payment', 'Store 1234')).toBeNull() // digits
    expect(extractPersonName('paypal', 'payment', 'PayPal transaction')).toBeNull() // recognizer fallback
  })
})

describe('isLikelyPerson', () => {
  it('accepts real names (including single first names)', () => {
    for (const n of ['Alice Smith', 'Mom', 'José García', "O'Brien"]) {
      expect(isLikelyPerson(n)).toBe(true)
    }
  })
  it('rejects merchants, domains, phones, groups, and corp suffixes', () => {
    for (const n of [
      'Netflix',
      'spotify',
      'ACME CORP',
      'Globex Inc',
      'shop.example.com',
      '+1 (415) 555-1234',
      'Alice & Bob',
      'Alice, Bob',
      'Acme Technologies',
      'Cash  App' // double-spaced merchant still normalizes to the known-merchant set
    ]) {
      expect(isLikelyPerson(n)).toBe(false)
    }
  })
})

describe('normalizeName', () => {
  it('lowercases + collapses whitespace', () => {
    expect(normalizeName('  John   Doe ')).toBe('john doe')
  })
})
