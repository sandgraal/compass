/**
 * Tests for the Venmo transaction-history recognizer (Phase 10). Covers the
 * preamble/summary-row skipping, the note→counterparty title, the signed-amount
 * body, the transaction-ID dedup key, and detection ahead of the generic catch-all.
 */

import { describe, expect, it } from 'vitest'
import { type RecognizerFile, recognize } from './recognizers'
import { VENMO_RECOGNIZER } from './venmo'

function file(name: string, text: string): RecognizerFile {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { name, ext, text }
}

// A Venmo statement: title + "Account Activity" + summary rows wrap the real header.
const VENMO = [
  'Account Statement - (@janedoe) - January 2026',
  'Account Activity',
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total)',
  ',,,,,,,,$100.00', // summary row: no ID/Datetime → skipped
  ',3300000000000000001,2026-01-15T10:30:00,Payment,Complete,Dinner,Jane Doe,John Smith,- $25.00',
  ',3300000000000000002,2026-01-20T14:00:00,Payment,Complete,Concert tickets,Bob,Jane Doe,+ $50.00'
].join('\n')

describe('Venmo transaction-history recognizer', () => {
  it('skips the preamble + summary rows and emits one record per transaction', () => {
    const f = file('venmo_statement.csv', VENMO)
    expect(recognize(f)?.id).toBe('venmo') // claims it ahead of the generic catch-all

    const out = VENMO_RECOGNIZER.parse(f)
    expect(out).toHaveLength(2) // the no-ID summary row is dropped
    expect(out.every((r) => r.source === 'venmo' && r.type === 'payment')).toBe(true)

    const dinner = out.find((r) => r.title === 'Dinner')
    expect(dinner?.body).toBe('- $25.00 · Jane Doe → John Smith')
    expect(dinner?.naturalKey).toBe('3300000000000000001') // transaction ID
    expect(dinner?.occurredAt).toBe(Date.parse('2026-01-15T10:30:00'))
  })

  it('does not claim a non-Venmo CSV', () => {
    const f = file('misc.csv', 'when,event\n2026-02-01,Did a thing\n')
    expect(VENMO_RECOGNIZER.detect(f)).toBe(false)
    expect(recognize(f)?.id).not.toBe('venmo')
  })
})
