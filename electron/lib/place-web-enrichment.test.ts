/**
 * Place web enrichment — pure-engine coverage: payload validation (clamps,
 * URL demotion, outcome coercion), proposal building (current-value diff,
 * citation verification), accepted-field collection, and the persisted
 * namespace assembly. Mirrors contact-web-enrichment.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { WebSource } from './contact-enrichment'
import {
  type PlaceWebEnrichProposal,
  assemblePlaceWebEnrichment,
  buildPlaceProposals,
  buildPlaceSearchedAs,
  buildPlaceWebEnrichUserMessage,
  collectAcceptedPlaceFields,
  parsePlaceFindingsFromText,
  parsePlaceSubmitPayload
} from './place-web-enrichment'

const SNAPSHOT = { category: null, address: null, url: null }
const SOURCES: WebSource[] = [
  { url: 'https://crossfitcartago.cr/', title: 'CrossFit Cartago' },
  { url: 'https://instagram.com/cfcartago', title: 'Instagram' }
]

const found = (match: Record<string, unknown>): unknown => ({
  outcome: 'found',
  matchConfidence: 'high',
  match
})

describe('buildPlaceSearchedAs / user message', () => {
  it('composes the identity string and the outbound message', () => {
    const input = {
      name: 'CrossFit Cartago',
      category: 'Gym',
      address: 'Av. 2, Cartago',
      kind: 'place',
      hints: 'near the ruins'
    }
    expect(buildPlaceSearchedAs(input)).toBe(
      'CrossFit Cartago (Gym, Av. 2, Cartago) — near the ruins'
    )
    const msg = buildPlaceWebEnrichUserMessage(input)
    expect(msg).toContain('Name: CrossFit Cartago')
    expect(msg).toContain('Category: Gym')
    expect(msg).toContain('Known address: Av. 2, Cartago')
    expect(msg).toContain('Extra context from the user: near the ruins')
  })

  it('says "business" for merchant rows', () => {
    expect(buildPlaceWebEnrichUserMessage({ name: 'Acme', kind: 'merchant' })).toContain(
      'this business'
    )
  })
})

describe('parsePlaceSubmitPayload', () => {
  it('validates a found payload and clamps values', () => {
    const parsed = parsePlaceSubmitPayload(
      found({
        category: { value: '  CrossFit gym ', confidence: 'high' },
        phone: { value: '+506 2551 0000', confidence: 'medium' },
        hours: { value: 'Mon–Sat 6:00–20:00', confidence: 'high' },
        links: [{ type: 'instagram', value: 'instagram.com/cfcartago' }],
        facts: [{ text: 'Hosted the 2025 nationals' }]
      })
    )
    expect(parsed?.outcome).toBe('found')
    expect(parsed?.match?.category?.value).toBe('CrossFit gym')
    expect(parsed?.match?.phone?.value).toBe('+506 2551 0000')
    // Bare domain normalized to https.
    expect(parsed?.match?.links[0].value).toBe('https://instagram.com/cfcartago')
    expect(parsed?.match?.facts[0].confidence).toBe('medium') // default
  })

  it('demotes an unsafe url to a fact', () => {
    const parsed = parsePlaceSubmitPayload(
      found({ url: { value: 'javascript:alert(1)', confidence: 'high' } })
    )
    expect(parsed?.match?.url).toBeUndefined()
    expect(parsed?.match?.facts[0].text).toContain('Website (unparsed)')
  })

  it('coerces an empty found match to not_found and validates candidates', () => {
    expect(parsePlaceSubmitPayload(found({}))).toMatchObject({ outcome: 'not_found' })
    expect(
      parsePlaceSubmitPayload({
        outcome: 'ambiguous',
        matchConfidence: 'low',
        candidates: [
          { name: 'CrossFit Cartago', descriptor: 'Av. 2 location' },
          { name: 'CrossFit Cartago Norte', descriptor: 'the northern box' }
        ]
      })
    ).toMatchObject({ outcome: 'ambiguous', candidates: [{ name: 'CrossFit Cartago' }, {}] })
    expect(parsePlaceSubmitPayload({ outcome: 'ambiguous', matchConfidence: 'low' })).toBeNull()
    expect(parsePlaceSubmitPayload({ outcome: 'nope' })).toBeNull()
  })

  it('salvages a prose answer containing JSON', () => {
    const parsed = parsePlaceFindingsFromText(
      `Here are my findings: {"outcome":"found","matchConfidence":"medium","match":{"category":{"value":"Gym","confidence":"high"}}} hope that helps`
    )
    expect(parsed?.match?.category?.value).toBe('Gym')
  })
})

describe('buildPlaceProposals', () => {
  it('diffs core fields, marks verification, and carries extras', () => {
    const parsed = parsePlaceSubmitPayload(
      found({
        category: {
          value: 'CrossFit gym',
          sourceUrl: 'https://crossfitcartago.cr',
          confidence: 'high'
        },
        url: {
          value: 'https://crossfitcartago.cr',
          sourceUrl: 'https://crossfitcartago.cr',
          confidence: 'high'
        },
        description: {
          value: 'A gym.',
          sourceUrl: 'https://elsewhere.example/page',
          confidence: 'medium'
        }
      })
    )
    const proposals = buildPlaceProposals(SNAPSHOT, parsed!, SOURCES)
    const byKind = Object.fromEntries(proposals.map((p) => [p.kind, p]))
    expect(byKind.category.writesToPlace).toBe(true)
    // Trailing-slash difference still matches a harvested source (urlKey).
    expect(byKind.category.sourceVerified).toBe(true)
    expect(byKind.description.writesToPlace).toBe(false)
    expect(byKind.description.sourceVerified).toBe(false) // not in SOURCES
    expect(proposals.map((p) => p.id)).toEqual(proposals.map((_, i) => i))
  })

  it('drops core proposals equal to the current value', () => {
    const parsed = parsePlaceSubmitPayload(
      found({ category: { value: 'gym', confidence: 'high' } })
    )
    expect(buildPlaceProposals({ ...SNAPSHOT, category: 'Gym' }, parsed!, SOURCES)).toHaveLength(0)
  })
})

describe('collectAcceptedPlaceFields / assemblePlaceWebEnrichment', () => {
  const proposals: PlaceWebEnrichProposal[] = [
    {
      id: 0,
      kind: 'category',
      currentValue: null,
      proposedValue: 'CrossFit gym',
      sourceVerified: true,
      confidence: 'high',
      writesToPlace: true
    },
    {
      id: 1,
      kind: 'phone',
      currentValue: null,
      proposedValue: '+506 2551 0000',
      sourceVerified: true,
      confidence: 'high',
      writesToPlace: false
    },
    {
      id: 2,
      kind: 'fact',
      currentValue: null,
      proposedValue: 'Hosted nationals',
      sourceVerified: false,
      confidence: 'low',
      writesToPlace: false
    }
  ]

  it('collects only accepted core fields', () => {
    expect(collectAcceptedPlaceFields(proposals, new Set([0, 1]))).toEqual({
      category: 'CrossFit gym'
    })
    expect(collectAcceptedPlaceFields(proposals, new Set([1, 2]))).toEqual({})
  })

  it('assembles the web namespace from accepted extras, keeping all sources', () => {
    const web = assemblePlaceWebEnrichment(proposals, new Set([0, 1]), {
      searchedAs: 'CrossFit Cartago',
      matchConfidence: 'high',
      sources: SOURCES,
      refreshedAt: 123
    })
    expect(web.phone).toBe('+506 2551 0000')
    expect(web.facts).toEqual([]) // fact id 2 not accepted
    expect(web.sources).toHaveLength(2)
    expect(web.refreshedAt).toBe(123)
  })
})
