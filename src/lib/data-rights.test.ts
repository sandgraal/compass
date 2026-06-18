import { describe, expect, it } from 'vitest'
import { DATA_RIGHTS_SOURCES } from './data-rights'

describe('data-rights catalog', () => {
  it('has well-formed entries with required copy', () => {
    expect(DATA_RIGHTS_SOURCES.length).toBeGreaterThan(8)
    for (const s of DATA_RIGHTS_SOURCES) {
      expect(Boolean(s.id && s.name && s.what && s.how && s.format && s.intoCompass)).toBe(true)
      expect(['Financial', 'Government', 'Health', 'Digital']).toContain(s.domain)
    }
  })

  it('uses https for every request link', () => {
    for (const s of DATA_RIGHTS_SOURCES) {
      if (s.url) expect(s.url).toMatch(/^https:\/\//)
    }
  })

  it('has unique ids', () => {
    const ids = DATA_RIGHTS_SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers all four rights domains', () => {
    const domains = new Set(DATA_RIGHTS_SOURCES.map((s) => s.domain))
    expect(domains).toEqual(new Set(['Financial', 'Government', 'Health', 'Digital']))
  })
})
