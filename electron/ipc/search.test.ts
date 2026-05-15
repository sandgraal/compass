/**
 * Tests for the search scoring helper — the file-system / vault /
 * SQLite-touching code paths are exercised in the running app; the
 * scoring math is what unit tests can lock in cheaply.
 */

import { describe, expect, it } from 'vitest'
import { _internal } from './search'

const { scoreMatch } = _internal

describe('scoreMatch', () => {
  it('returns 0 when the needle is absent', () => {
    expect(scoreMatch('Hello world', 'foo')).toBe(0)
  })

  it('rewards earlier matches over later ones', () => {
    const early = scoreMatch('coffee at the cafe', 'coffee')
    const late = scoreMatch('we drove out for some coffee', 'coffee')
    expect(early).toBeGreaterThan(late)
  })

  it('rewards whole-word matches', () => {
    const whole = scoreMatch('budget for april', 'april')
    const partial = scoreMatch('aprilita is here', 'april')
    expect(whole).toBeGreaterThan(partial)
  })

  it('penalises long haystacks', () => {
    const short = scoreMatch('apple', 'apple')
    const long = scoreMatch(`apple ${'x '.repeat(200)}`, 'apple')
    expect(short).toBeGreaterThan(long)
  })

  it('is case-insensitive', () => {
    expect(scoreMatch('Hello WORLD', 'hello')).toBeGreaterThan(0)
    expect(scoreMatch('Hello WORLD', 'world')).toBeGreaterThan(0)
  })
})
