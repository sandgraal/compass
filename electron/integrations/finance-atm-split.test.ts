import { describe, expect, it } from 'vitest'
import { SPLIT_MARKER_PERSONAL, SPLIT_MARKER_PROJECT, _internal } from './finance-atm-split'

const { isCrAtm, isAlreadySplit, splitAmount } = _internal

describe('isCrAtm', () => {
  it('matches CR ATM patterns when category is Cash', () => {
    expect(isCrAtm('BANCO POPULAR C SAN JOSE', 'Cash', null)).toBe(true)
    expect(isCrAtm('SCOTIABANK COST SAN JOSE', 'Cash', null)).toBe(true)
    expect(isCrAtm('020004031 CARTAGO', 'Cash', null)).toBe(true)
  })

  it('rejects non-Cash categories even with CR keywords', () => {
    expect(isCrAtm('SUPERMERCADO LA LEYENDA CARTAGO', 'Food & Drink', 'Groceries')).toBe(false)
  })

  it('rejects US ATMs (West Palm Beach Pai)', () => {
    expect(isCrAtm('PAI ATM WEST PALM BEACH', 'Cash', null)).toBe(false)
    expect(isCrAtm('PAI ISO WEST PALM BEACH', 'Cash', null)).toBe(false)
  })

  it('skips already-split sibling rows', () => {
    expect(isCrAtm('BANCO POPULAR C SAN JOSE', 'Cash', 'Personal — split sibling')).toBe(false)
  })
})

describe('isAlreadySplit', () => {
  it('detects the project marker', () => {
    expect(isAlreadySplit(`other notes | ${SPLIT_MARKER_PROJECT} (estimate)`)).toBe(true)
  })

  it('detects the personal sibling marker', () => {
    expect(isAlreadySplit(`${SPLIT_MARKER_PERSONAL} (sibling of XYZ)`)).toBe(true)
  })

  it('returns false when notes are empty or unrelated', () => {
    expect(isAlreadySplit(null)).toBe(false)
    expect(isAlreadySplit('rm:Cash & Checks')).toBe(false)
  })
})

describe('splitAmount', () => {
  it('splits to 70/30 with sane rounding', () => {
    expect(splitAmount(-100)).toEqual({ project: -70, personal: -30 })
    expect(splitAmount(-675.31)).toEqual({ project: -472.72, personal: -202.59 })
  })

  it('avoids float drift — project + personal must equal original', () => {
    for (const amt of [-100, -675.31, -1.0, -39.83, -1234.56]) {
      const { project, personal } = splitAmount(amt)
      expect(project + personal).toBeCloseTo(amt, 2)
    }
  })
})
