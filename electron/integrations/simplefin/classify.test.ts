/**
 * Tests for the conservative SimpleFIN account-type classifier.
 *
 * The headline case: an Amex card must land as a credit / liability (not a
 * spending asset) so net-worth + the cash-flow forecast treat it correctly.
 * Ambiguous names fall back to checking/spending.
 */

import { describe, expect, it } from 'vitest'
import { classifySimplefinAccount } from './classify'

describe('classifySimplefinAccount — debt', () => {
  it.each([
    ['Platinum Card', 'American Express'],
    ['Blue Cash Everyday Card', 'American Express'],
    ['Sapphire Preferred Credit Card', 'Chase'],
    ['Quicksilver', 'Capital One Mastercard'],
    ['Signature Visa', 'Bank of America']
  ])('classifies "%s" / "%s" as a credit liability', (name, org) => {
    const c = classifySimplefinAccount(name, org)
    expect(c.type).toBe('credit')
    expect(c.isDebt).toBe(true)
    expect(c.assetClass).toBe('liability')
  })

  it.each([
    ['Home Mortgage', 'Wells Fargo'],
    ['Auto Loan', 'Ally'],
    ['HELOC', 'Citizens']
  ])('classifies "%s" as a debt liability', (name, org) => {
    const c = classifySimplefinAccount(name, org)
    expect(c.isDebt).toBe(true)
    expect(c.assetClass).toBe('liability')
  })
})

describe('classifySimplefinAccount — assets', () => {
  it('classifies savings', () => {
    const c = classifySimplefinAccount('High Yield Savings', 'Marcus')
    expect(c.type).toBe('savings')
    expect(c.isDebt).toBe(false)
    expect(c.assetClass).toBe('savings')
  })

  it('classifies investment / retirement', () => {
    const c = classifySimplefinAccount('Roth IRA', 'Fidelity')
    expect(c.type).toBe('investment')
    expect(c.assetClass).toBe('retirement')
  })

  it('falls back to checking/spending for an ambiguous name', () => {
    const c = classifySimplefinAccount('Everyday Account', 'Some Bank')
    expect(c.type).toBe('checking')
    expect(c.isDebt).toBe(false)
    expect(c.assetClass).toBe('spending')
  })
})

describe('classifySimplefinAccount — precedence', () => {
  it('treats a savings-secured CARD as debt (debt signal wins)', () => {
    const c = classifySimplefinAccount('Savings Secured Credit Card', 'Discover')
    expect(c.isDebt).toBe(true)
    expect(c.assetClass).toBe('liability')
  })
})
