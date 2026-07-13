/**
 * Tests for the pure life-records logic (the vault split) — category
 * templates, the secret-field allowlist, title derivation, and
 * `splitVaultEntry` (legacy vault entry → plaintext row + secret remnant).
 */
import { describe, expect, it } from 'vitest'
import {
  LIFE_CATEGORIES,
  LIFE_CATEGORY_IDS,
  SECRET_FIELDS_BY_CATEGORY,
  deriveTitle,
  isLifeCategory,
  splitVaultEntry
} from './life-records'

describe('category tables', () => {
  it('covers exactly the five migrated vault document categories', () => {
    expect(LIFE_CATEGORY_IDS).toEqual([
      'financial',
      'identity',
      'medical',
      'legal',
      'foreign-accounts'
    ])
    expect(isLifeCategory('financial')).toBe(true)
    expect(isLifeCategory('credentials')).toBe(false) // stays in the vault
    expect(isLifeCategory('genetics')).toBe(false)
  })

  it('derives the secret allowlist from the templates', () => {
    expect(SECRET_FIELDS_BY_CATEGORY.financial).toEqual(['accountNumber', 'routingNumber'])
    expect(SECRET_FIELDS_BY_CATEGORY.identity).toEqual(['number'])
    expect(SECRET_FIELDS_BY_CATEGORY.medical).toEqual(['memberId', 'groupNumber'])
    expect(SECRET_FIELDS_BY_CATEGORY.legal).toEqual([])
    expect(SECRET_FIELDS_BY_CATEGORY['foreign-accounts']).toEqual(['accountNumber'])
  })

  it('never marks notes as a template field (dedicated column)', () => {
    for (const cat of LIFE_CATEGORIES) {
      expect(cat.fields.map((f) => f.key)).not.toContain('notes')
    }
  })
})

describe('deriveTitle', () => {
  it('uses the first non-empty title field in priority order', () => {
    expect(deriveTitle('financial', { institution: 'Chase', accountType: 'Checking' })).toBe(
      'Chase'
    )
    expect(deriveTitle('financial', { accountType: 'Checking' })).toBe('Checking')
    expect(deriveTitle('legal', { documentType: 'Will' })).toBe('Will')
  })

  it('falls back to the category label', () => {
    expect(deriveTitle('medical', {})).toBe('Medical record')
    expect(deriveTitle('nonsense', {})).toBe('Life record')
  })
})

describe('splitVaultEntry', () => {
  it('routes secret-allowlisted values to secrets, everything else to fields', () => {
    const split = splitVaultEntry('financial', {
      id: 'abc',
      institution: 'USAA',
      accountType: 'Checking',
      accountNumber: '123456789',
      routingNumber: '021000021',
      notes: 'primary account',
      createdAt: 1700000000000,
      updatedAt: 1700000001000
    })
    expect(split.title).toBe('USAA')
    expect(split.fields).toEqual({ institution: 'USAA', accountType: 'Checking' })
    expect(split.secrets).toEqual({ accountNumber: '123456789', routingNumber: '021000021' })
    expect(split.notes).toBe('primary account')
    expect(split.createdAt).toBe(1700000000000)
    expect(split.updatedAt).toBe(1700000001000)
  })

  it('strips system keys and drops _history (the .migrated.enc backup keeps it)', () => {
    const split = splitVaultEntry('identity', {
      id: 'x',
      documentType: 'Passport',
      number: 'X1234567',
      _history: [{ number: 'OLD' }],
      _autoSeeded: true
    })
    expect(split.fields).toEqual({ documentType: 'Passport' })
    expect(split.secrets).toEqual({ number: 'X1234567' })
    expect(JSON.stringify(split)).not.toContain('OLD')
    expect(JSON.stringify(split)).not.toContain('_autoSeeded')
  })

  it('turns a masked ••••1234 accountNumber stub into a plaintext lastFour, not a secret', () => {
    const split = splitVaultEntry('financial', {
      id: 's',
      institution: 'Amex',
      accountType: 'Credit Card',
      accountNumber: '••••1003',
      _autoSeeded: true
    })
    expect(split.fields).toEqual({
      institution: 'Amex',
      accountType: 'Credit Card',
      lastFour: '1003'
    })
    expect(split.secrets).toEqual({})
  })

  it('keeps a REAL account number a secret even when short', () => {
    const split = splitVaultEntry('financial', {
      id: 's2',
      institution: 'CU',
      accountNumber: '99881234'
    })
    expect(split.secrets.accountNumber).toBe('99881234')
    expect(split.fields.lastFour).toBeUndefined()
  })

  it('handles empty/blank/non-string values and legal (no secrets) entries', () => {
    const split = splitVaultEntry('legal', {
      id: 'l1',
      documentType: 'Deed',
      parties: '  ',
      date: '2024-05-01',
      location: null,
      weird: { nested: true },
      maxDepth: 3
    })
    expect(split.fields).toEqual({ documentType: 'Deed', date: '2024-05-01', maxDepth: '3' })
    expect(split.secrets).toEqual({})
    expect(split.notes).toBeNull()
    expect(split.title).toBe('Deed')
  })
})
