/**
 * Subscription web enrichment — pure-engine coverage: payload validation
 * (clamps, URL demotion, outcome coercion), proposal building (cancelUrl
 * diff, citation verification, the subscription-specific proposal kinds),
 * accepted-field collection, and the persisted namespace assembly. Mirrors
 * place-web-enrichment.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { WebSource } from './contact-enrichment'
import {
  type SubscriptionWebEnrichProposal,
  assembleSubscriptionWebEnrichment,
  buildSubscriptionProposals,
  buildSubscriptionSearchedAs,
  buildSubscriptionWebEnrichUserMessage,
  collectAcceptedSubscriptionFields,
  parseSubscriptionFindingsFromText,
  parseSubscriptionSubmitPayload
} from './subscription-web-enrichment'

const SNAPSHOT = { cancelUrl: null }
const SOURCES: WebSource[] = [
  { url: 'https://netflix.com/cancelplan', title: 'Cancel your plan' },
  { url: 'https://help.netflix.com/', title: 'Netflix Help Center' }
]

const found = (match: Record<string, unknown>): unknown => ({
  outcome: 'found',
  matchConfidence: 'high',
  match
})

describe('buildSubscriptionSearchedAs / user message', () => {
  it('composes the identity string and the outbound message', () => {
    const input = {
      name: 'Netflix',
      category: 'Streaming',
      cost: 15.49,
      cadence: 'monthly',
      hints: 'the standard plan, not premium'
    }
    expect(buildSubscriptionSearchedAs(input)).toBe(
      'Netflix (Streaming, monthly, ~15.49) — the standard plan, not premium'
    )
    const msg = buildSubscriptionWebEnrichUserMessage(input)
    expect(msg).toContain('Name: Netflix')
    expect(msg).toContain('Category: Streaming')
    expect(msg).toContain('What the user currently pays: ~15.49 per monthly')
    expect(msg).toContain('Extra context from the user: the standard plan, not premium')
  })

  it('includes a known-site hint when a linked merchant already has one', () => {
    const msg = buildSubscriptionWebEnrichUserMessage({
      name: 'Netflix',
      cost: 15.49,
      cadence: 'monthly',
      knownUrlHint: 'https://netflix.com'
    })
    expect(msg).toContain('Known official site: https://netflix.com')
  })
})

describe('parseSubscriptionSubmitPayload', () => {
  it('validates a found payload and clamps values', () => {
    const parsed = parseSubscriptionSubmitPayload(
      found({
        pricingSummary: { value: '  $15.49/month ', confidence: 'high' },
        annualDiscount: { value: '~17% cheaper billed annually', confidence: 'medium' },
        plans: [
          { name: 'Standard', price: '$15.49/month', note: 'HD, 2 screens' },
          { name: 'Premium', price: '$22.99/month', note: '4K, 4 screens' }
        ],
        benefits: [{ text: 'Offline downloads' }],
        cancellationSteps: { value: '1. Go to Account. 2. Cancel Membership.', confidence: 'high' },
        cancellationUrl: { value: 'netflix.com/cancelplan', confidence: 'high' },
        supportUrl: { value: 'help.netflix.com', confidence: 'high' },
        alternatives: [{ name: 'Max', note: 'More live sports', approxPrice: '$16/month' }]
      })
    )
    expect(parsed?.outcome).toBe('found')
    expect(parsed?.match?.pricingSummary?.value).toBe('$15.49/month')
    expect(parsed?.match?.plans).toHaveLength(2)
    expect(parsed?.match?.plans[0]).toMatchObject({ name: 'Standard', price: '$15.49/month' })
    expect(parsed?.match?.benefits[0].confidence).toBe('medium') // default
    // Bare domains normalized to https.
    expect(parsed?.match?.cancellationUrl?.value).toBe('https://netflix.com/cancelplan')
    expect(parsed?.match?.supportUrl?.value).toBe('https://help.netflix.com')
    expect(parsed?.match?.alternatives[0]).toMatchObject({ name: 'Max', approxPrice: '$16/month' })
  })

  it('demotes an unsafe cancellation url to a benefit fact', () => {
    const parsed = parseSubscriptionSubmitPayload(
      found({ cancellationUrl: { value: 'javascript:alert(1)', confidence: 'high' } })
    )
    expect(parsed?.match?.cancellationUrl).toBeUndefined()
    expect(parsed?.match?.benefits[0].text).toContain('Cancellation page (unparsed)')
  })

  it('drops a plan/alternative missing a required field', () => {
    const parsed = parseSubscriptionSubmitPayload(
      found({
        plans: [{ name: 'No price here' }, { name: 'Standard', price: '$15.49/month' }],
        alternatives: [{ name: 'No note here' }]
      })
    )
    expect(parsed?.match?.plans).toHaveLength(1)
    expect(parsed?.match?.alternatives).toHaveLength(0)
  })

  it('coerces an empty found match to not_found and validates candidates', () => {
    expect(parseSubscriptionSubmitPayload(found({}))).toMatchObject({ outcome: 'not_found' })
    expect(
      parseSubscriptionSubmitPayload({
        outcome: 'ambiguous',
        matchConfidence: 'low',
        candidates: [
          { name: 'Max', descriptor: 'the streaming service' },
          { name: 'Max (fitness app)', descriptor: 'unrelated fitness app, same name' }
        ]
      })
    ).toMatchObject({ outcome: 'ambiguous', candidates: [{ name: 'Max' }, {}] })
    expect(
      parseSubscriptionSubmitPayload({ outcome: 'ambiguous', matchConfidence: 'low' })
    ).toBeNull()
    expect(parseSubscriptionSubmitPayload({ outcome: 'nope' })).toBeNull()
  })

  it('salvages a prose answer containing JSON', () => {
    const parsed = parseSubscriptionFindingsFromText(
      `Here are my findings: {"outcome":"found","matchConfidence":"medium","match":{"pricingSummary":{"value":"$9.99/month","confidence":"high"}}} hope that helps`
    )
    expect(parsed?.match?.pricingSummary?.value).toBe('$9.99/month')
  })
})

describe('buildSubscriptionProposals', () => {
  it('builds every proposal kind, marks verification, and carries labels', () => {
    const parsed = parseSubscriptionSubmitPayload(
      found({
        pricingSummary: { value: '$15.49/month', confidence: 'high' },
        plans: [{ name: 'Premium', price: '$22.99/month', sourceUrl: 'https://help.netflix.com' }],
        benefits: [{ text: 'Offline downloads', sourceUrl: 'https://elsewhere.example/page' }],
        cancellationUrl: {
          value: 'https://netflix.com/cancelplan',
          sourceUrl: 'https://netflix.com/cancelplan',
          confidence: 'high'
        },
        alternatives: [{ name: 'Max', note: 'More live sports' }]
      })
    )
    const proposals = buildSubscriptionProposals(SNAPSHOT, parsed!, SOURCES)
    const byKind = Object.fromEntries(proposals.map((p) => [p.kind, p]))
    expect(byKind.pricing.writesToSubscription).toBe(false)
    expect(byKind.planTier.label).toBe('Premium')
    expect(byKind.planTier.sourceVerified).toBe(true) // help.netflix.com is in SOURCES
    expect(byKind.benefit.sourceVerified).toBe(false) // not in SOURCES
    expect(byKind.cancellationUrl.writesToSubscription).toBe(true)
    expect(byKind.cancellationUrl.sourceVerified).toBe(true)
    expect(byKind.alternative.label).toBe('Max')
    expect(proposals.map((p) => p.id)).toEqual(proposals.map((_, i) => i))
  })

  it('drops a cancellationUrl proposal equal to the current value', () => {
    const parsed = parseSubscriptionSubmitPayload(
      found({ cancellationUrl: { value: 'https://netflix.com/cancelplan', confidence: 'high' } })
    )
    const proposals = buildSubscriptionProposals(
      { cancelUrl: 'https://netflix.com/cancelplan' },
      parsed!,
      SOURCES
    )
    expect(proposals.find((p) => p.kind === 'cancellationUrl')).toBeUndefined()
  })
})

describe('collectAcceptedSubscriptionFields / assembleSubscriptionWebEnrichment', () => {
  const proposals: SubscriptionWebEnrichProposal[] = [
    {
      id: 0,
      kind: 'cancellationUrl',
      currentValue: null,
      proposedValue: 'https://netflix.com/cancelplan',
      sourceVerified: true,
      confidence: 'high',
      writesToSubscription: true
    },
    {
      id: 1,
      kind: 'pricing',
      currentValue: null,
      proposedValue: '$15.49/month',
      sourceVerified: true,
      confidence: 'high',
      writesToSubscription: false
    },
    {
      id: 2,
      kind: 'benefit',
      currentValue: null,
      proposedValue: 'Offline downloads',
      sourceVerified: false,
      confidence: 'low',
      writesToSubscription: false
    }
  ]

  it('collects only the accepted cancelUrl field', () => {
    expect(collectAcceptedSubscriptionFields(proposals, new Set([0, 1]))).toEqual({
      cancelUrl: 'https://netflix.com/cancelplan'
    })
    expect(collectAcceptedSubscriptionFields(proposals, new Set([1, 2]))).toEqual({})
  })

  it('assembles the web namespace from accepted extras, keeping all sources', () => {
    const web = assembleSubscriptionWebEnrichment(proposals, new Set([0, 1]), {
      searchedAs: 'Netflix',
      matchConfidence: 'high',
      sources: SOURCES,
      refreshedAt: 123
    })
    expect(web.pricingSummary).toBe('$15.49/month')
    expect(web.cancellationUrl).toBe('https://netflix.com/cancelplan')
    expect(web.benefits).toEqual([]) // benefit id 2 not accepted
    expect(web.sources).toHaveLength(2)
    expect(web.refreshedAt).toBe(123)
  })
})
