/**
 * Merchant web-enrichment engine — the defensive validation layer for the one
 * place Compass looks a BUSINESS up on the web. Coverage mirrors the contacts
 * sibling: payload clamping (URL sanitizing, email shape, demote-to-fact),
 * candidate handling, proposal diffing + citation verification, and the
 * accepted-fields / persisted-namespace assembly.
 */
import { describe, expect, it } from 'vitest'
import type { WebSource } from './contact-enrichment'
import {
  type MerchantWebProposal,
  type MerchantWebSnapshot,
  assembleMerchantWebEnrichment,
  buildMerchantProposals,
  buildMerchantSearchedAs,
  buildMerchantWebEnrichUserMessage,
  collectMerchantAcceptedFields,
  parseMerchantFindingsFromText,
  parseMerchantSubmitPayload
} from './merchant-web-enrichment'

const EMPTY_SNAPSHOT: MerchantWebSnapshot = {
  url: null,
  category: null,
  address: null,
  supportEmail: null,
  supportPhone: null
}

const sv = (value: string, sourceUrl?: string, confidence = 'high'): Record<string, unknown> => ({
  value,
  sourceUrl,
  confidence
})

describe('parseMerchantSubmitPayload', () => {
  it('validates a full found payload', () => {
    const parsed = parseMerchantSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: {
        url: sv('bluebottle.com', 'https://bluebottle.com'),
        category: sv('Coffee shop', 'https://bluebottle.com/about'),
        address: sv('300 Webster St, Oakland CA'),
        supportEmail: sv('help@bluebottle.com', 'https://bluebottle.com/contact'),
        supportPhone: sv('+1 510-555-0100'),
        description: sv('Specialty coffee roaster and cafe chain.'),
        links: [{ type: 'support', value: 'https://support.bluebottle.com' }],
        facts: [{ text: 'Owned by Nestlé since 2017', sourceUrl: 'https://example.com/news' }]
      }
    })
    expect(parsed?.outcome).toBe('found')
    // Bare domain normalized to https.
    expect(parsed?.match?.url?.value).toBe('https://bluebottle.com')
    expect(parsed?.match?.supportEmail?.value).toBe('help@bluebottle.com')
    expect(parsed?.match?.links).toHaveLength(1)
    expect(parsed?.match?.facts).toHaveLength(1)
  })

  it('demotes a non-URL website and a malformed email to facts', () => {
    const parsed = parseMerchantSubmitPayload({
      outcome: 'found',
      matchConfidence: 'medium',
      match: {
        url: sv('javascript:alert(1)'),
        supportEmail: sv('call the store'),
        facts: []
      }
    })
    expect(parsed?.match?.url).toBeUndefined()
    expect(parsed?.match?.supportEmail).toBeUndefined()
    expect(parsed?.match?.facts.map((f) => f.text)).toEqual([
      'Website (unparsed): javascript:alert(1)',
      'Support contact (unparsed): call the store'
    ])
  })

  it('drops unsafe link URLs entirely', () => {
    const parsed = parseMerchantSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: {
        category: sv('Coffee'),
        links: [
          { type: 'support', value: 'data:text/html,x' },
          { type: 'status', value: 'https://status.example.com' }
        ]
      }
    })
    expect(parsed?.match?.links).toEqual([
      { type: 'status', value: 'https://status.example.com', sourceUrl: undefined }
    ])
  })

  it('handles ambiguous with clamped candidates and rejects junk', () => {
    const parsed = parseMerchantSubmitPayload({
      outcome: 'ambiguous',
      matchConfidence: 'low',
      candidates: [
        { name: 'Blue Bottle Coffee', descriptor: 'Roaster chain, Oakland CA' },
        { name: 'Blue Bottle Cafe', descriptor: 'Restaurant in San Jose CA' },
        { bad: true }
      ]
    })
    expect(parsed?.outcome).toBe('ambiguous')
    expect(parsed?.candidates).toHaveLength(2)

    expect(parseMerchantSubmitPayload({ outcome: 'ambiguous', candidates: [] })).toBeNull()
    expect(parseMerchantSubmitPayload({ outcome: 'nope' })).toBeNull()
    expect(parseMerchantSubmitPayload(null)).toBeNull()
  })

  it('an empty found match degrades to not_found', () => {
    const parsed = parseMerchantSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: {}
    })
    expect(parsed?.outcome).toBe('not_found')
  })
})

describe('parseMerchantFindingsFromText', () => {
  it('salvages the first balanced JSON object from prose', () => {
    const parsed = parseMerchantFindingsFromText(
      `Here is what I found: {"outcome":"found","matchConfidence":"high","match":{"category":{"value":"Coffee","confidence":"high"}}} hope that helps`
    )
    expect(parsed?.match?.category?.value).toBe('Coffee')
    expect(parseMerchantFindingsFromText('no json here')).toBeNull()
  })
})

describe('buildMerchantProposals', () => {
  const SOURCES: WebSource[] = [{ url: 'https://bluebottle.com/about' }]

  it('diffs against the snapshot, marks writes, and verifies citations', () => {
    const findings = parseMerchantSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: {
        category: sv('Coffee shop', 'https://bluebottle.com/about'),
        url: sv('https://bluebottle.com', 'https://elsewhere.com/page'),
        description: sv('Specialty coffee roaster.'),
        facts: [{ text: 'Founded 2002' }]
      }
    })
    const proposals = buildMerchantProposals(EMPTY_SNAPSHOT, findings!, SOURCES)
    const byKind = Object.fromEntries(proposals.map((p) => [p.kind, p]))
    expect(byKind.category.writesToMerchant).toBe(true)
    expect(byKind.category.sourceVerified).toBe(true) // cited page was actually returned
    expect(byKind.url.sourceVerified).toBe(false) // hallucinated citation
    expect(byKind.description.writesToMerchant).toBe(false)
    expect(byKind.fact.writesToMerchant).toBe(false)
  })

  it('drops proposals equal to the current value (case-insensitive)', () => {
    const findings = parseMerchantSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: { category: sv('COFFEE SHOP') }
    })
    const proposals = buildMerchantProposals(
      { ...EMPTY_SNAPSHOT, category: 'Coffee shop' },
      findings!,
      []
    )
    expect(proposals).toHaveLength(0)
  })
})

describe('collectMerchantAcceptedFields / assembleMerchantWebEnrichment', () => {
  const proposals: MerchantWebProposal[] = [
    {
      id: 0,
      kind: 'url',
      currentValue: null,
      proposedValue: 'https://bluebottle.com',
      sourceVerified: true,
      confidence: 'high',
      writesToMerchant: true
    },
    {
      id: 1,
      kind: 'supportEmail',
      currentValue: null,
      proposedValue: 'help@bluebottle.com',
      sourceVerified: true,
      confidence: 'high',
      writesToMerchant: true
    },
    {
      id: 2,
      kind: 'description',
      currentValue: null,
      proposedValue: 'Specialty coffee roaster.',
      sourceVerified: true,
      confidence: 'high',
      writesToMerchant: false
    },
    {
      id: 3,
      kind: 'fact',
      currentValue: null,
      proposedValue: 'Founded 2002',
      sourceVerified: false,
      confidence: 'low',
      writesToMerchant: false
    }
  ]

  it('collects only the ACCEPTED record fields', () => {
    const fields = collectMerchantAcceptedFields(proposals, new Set([0, 2]))
    expect(fields).toEqual({ url: 'https://bluebottle.com' })
  })

  it('assembles the persisted namespace from accepted web items, keeping all sources', () => {
    const web = assembleMerchantWebEnrichment(proposals, new Set([2]), {
      searchedAs: 'Blue Bottle (Coffee shop)',
      matchConfidence: 'high',
      sources: [{ url: 'https://bluebottle.com/about' }],
      refreshedAt: 123,
      model: 'claude-test'
    })
    expect(web.description).toBe('Specialty coffee roaster.')
    expect(web.facts).toHaveLength(0) // rejected fact never persists
    expect(web.sources).toHaveLength(1)
    expect(web.refreshedAt).toBe(123)
  })
})

describe('prompt builders', () => {
  it('buildMerchantSearchedAs composes name, category/address, and hints', () => {
    expect(
      buildMerchantSearchedAs({
        name: 'BLUE BOTTLE OAK',
        category: 'Coffee',
        address: 'Oakland CA',
        hints: 'the one near the lake'
      })
    ).toBe('BLUE BOTTLE OAK (Coffee, Oakland CA) — the one near the lake')
  })

  it('user message includes only provided fields', () => {
    const msg = buildMerchantWebEnrichUserMessage({ name: 'Netflix' })
    expect(msg).toContain('Netflix')
    expect(msg).not.toContain('Category:')
    expect(msg).not.toContain('Known website:')
  })
})
