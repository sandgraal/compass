/**
 * Tests for the pure web-enrichment engine: defensive payload validation,
 * citation harvesting/verification, proposal diffing, and the accepted-only
 * assembly of the persisted `web` namespace. Everything the model returns is
 * untrusted — these tests are the spec for what survives.
 */
import { describe, expect, it } from 'vitest'
import type { AnthropicContentBlock } from '../integrations/llm-client'
import {
  type ParsedWebFindings,
  type WebEnrichContactSnapshot,
  assembleWebEnrichment,
  buildProposals,
  buildSearchedAs,
  buildWebEnrichUserMessage,
  collectAcceptedFields,
  harvestSources,
  parseFindingsFromText,
  parseSubmitPayload,
  sanitizeUrl
} from './contact-web-enrichment'

const EMPTY_SNAPSHOT: WebEnrichContactSnapshot = {
  jobTitle: null,
  org: null,
  birthday: null,
  url: null
}

describe('sanitizeUrl', () => {
  it('keeps http(s), normalizes bare domains, rejects everything else', () => {
    expect(sanitizeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com')
    expect(sanitizeUrl('github.com/jane')).toBe('https://github.com/jane')
    expect(sanitizeUrl('javascript:alert(1)')).toBeUndefined()
    expect(sanitizeUrl('data:text/html,x')).toBeUndefined()
    expect(sanitizeUrl('')).toBeUndefined()
    expect(sanitizeUrl(42)).toBeUndefined()
  })
})

describe('parseSubmitPayload', () => {
  it('rejects garbage and unknown outcomes', () => {
    expect(parseSubmitPayload(null)).toBeNull()
    expect(parseSubmitPayload('found')).toBeNull()
    expect(parseSubmitPayload({})).toBeNull()
    expect(parseSubmitPayload({ outcome: 'maybe' })).toBeNull()
  })

  it('validates a found payload and strips unsafe URLs', () => {
    const parsed = parseSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: {
        jobTitle: { value: 'VP Eng', sourceUrl: 'javascript:alert(1)', confidence: 'high' },
        links: [
          { type: 'github', value: 'github.com/jane' },
          { type: 'evil', value: 'javascript:alert(1)' }
        ],
        facts: [{ text: 'Spoke at PyCon', sourceUrl: 'https://pycon.org/x', confidence: 'silly' }]
      }
    })
    expect(parsed?.outcome).toBe('found')
    expect(parsed?.match?.jobTitle).toEqual({
      value: 'VP Eng',
      sourceUrl: undefined,
      confidence: 'high'
    })
    // Bare domain normalized; javascript: link dropped entirely.
    expect(parsed?.match?.links).toEqual([
      { type: 'github', value: 'https://github.com/jane', sourceUrl: undefined }
    ])
    // Unknown confidence collapses to 'medium'.
    expect(parsed?.match?.facts[0].confidence).toBe('medium')
  })

  it('clamps oversized values and caps list lengths', () => {
    const parsed = parseSubmitPayload({
      outcome: 'found',
      matchConfidence: 'medium',
      match: {
        bio: { value: 'x'.repeat(10_000), confidence: 'high' },
        facts: Array.from({ length: 40 }, (_, i) => ({ text: `fact ${i}` }))
      }
    })
    expect(parsed?.match?.bio?.value).toHaveLength(4000)
    expect(parsed?.match?.facts).toHaveLength(20)
  })

  it('demotes a malformed birthday and non-url website to facts', () => {
    const parsed = parseSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: {
        birthday: { value: 'March 5th', sourceUrl: 'https://a.com', confidence: 'low' },
        url: { value: 'not a url at all !!', confidence: 'medium' }
      }
    })
    expect(parsed?.match?.birthday).toBeUndefined()
    expect(parsed?.match?.url).toBeUndefined()
    expect(parsed?.match?.facts.map((f) => f.text)).toEqual([
      'Birthday (unparsed): March 5th',
      'Website (unparsed): not a url at all !!'
    ])
  })

  it('keeps a well-formed ISO birthday', () => {
    const parsed = parseSubmitPayload({
      outcome: 'found',
      matchConfidence: 'high',
      match: { birthday: { value: '1985-03-05', confidence: 'high' } }
    })
    expect(parsed?.match?.birthday?.value).toBe('1985-03-05')
  })

  it('collapses a found payload with no usable content to not_found', () => {
    const parsed = parseSubmitPayload({
      outcome: 'found',
      matchConfidence: 'low',
      match: { links: [{ value: 'javascript:x' }] }
    })
    expect(parsed?.outcome).toBe('not_found')
  })

  it('validates candidates and caps them at 5; empty candidates is unusable', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `Jane ${i}`,
      descriptor: `the ${i}th one`
    }))
    const parsed = parseSubmitPayload({
      outcome: 'ambiguous',
      matchConfidence: 'low',
      candidates: [...many, { name: 'no descriptor' }]
    })
    expect(parsed?.outcome).toBe('ambiguous')
    expect(parsed?.candidates).toHaveLength(5)
    expect(parseSubmitPayload({ outcome: 'ambiguous', candidates: [] })).toBeNull()
  })
})

describe('parseFindingsFromText', () => {
  it('salvages the first balanced JSON object out of prose', () => {
    const text = `Here is what I found:\n{"outcome":"found","matchConfidence":"high","match":{"org":{"value":"Acme","confidence":"high"}}}\nHope that helps!`
    const parsed = parseFindingsFromText(text)
    expect(parsed?.match?.org?.value).toBe('Acme')
  })
  it('returns null when there is no JSON or it is invalid', () => {
    expect(parseFindingsFromText('no json here')).toBeNull()
    expect(parseFindingsFromText('{"outcome": broken')).toBeNull()
  })
})

describe('harvestSources', () => {
  const resultBlock = (urls: string[]): AnthropicContentBlock => ({
    type: 'web_search_tool_result',
    tool_use_id: 'st1',
    content: urls.map((url) => ({ type: 'web_search_result', url, title: `Page ${url}` }))
  })

  it('collects urls from result blocks, deduping near-identical ones', () => {
    const sources = harvestSources([
      { type: 'server_tool_use', id: 'st1', name: 'web_search', input: {} },
      resultBlock(['https://a.com/x', 'https://A.com/x/', 'https://b.com']),
      { type: 'text', text: 'done' }
    ])
    expect(sources.map((s) => s.url)).toEqual(['https://a.com/x', 'https://b.com'])
  })

  it('skips error-shaped result blocks (object content) without throwing', () => {
    const sources = harvestSources([
      {
        type: 'web_search_tool_result',
        tool_use_id: 'st1',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
      },
      resultBlock(['https://ok.com'])
    ])
    expect(sources.map((s) => s.url)).toEqual(['https://ok.com'])
  })

  it('handles undefined rawContent', () => {
    expect(harvestSources(undefined)).toEqual([])
  })
})

function foundFindings(): ParsedWebFindings {
  return {
    outcome: 'found',
    matchConfidence: 'high',
    match: {
      jobTitle: { value: 'VP Engineering', sourceUrl: 'https://acme.com/team', confidence: 'high' },
      org: { value: 'Acme Corp', sourceUrl: 'https://acme.com/team', confidence: 'high' },
      bio: { value: 'Engineer and speaker.', sourceUrl: 'https://jane.dev', confidence: 'medium' },
      links: [
        { type: 'github', value: 'https://github.com/jane', sourceUrl: 'https://github.com/jane' }
      ],
      facts: [
        { text: 'Spoke at PyCon 2025', sourceUrl: 'https://madeup.example/x', confidence: 'low' }
      ]
    }
  }
}

const SOURCES = [
  { url: 'https://acme.com/team', title: 'Team — Acme' },
  { url: 'https://github.com/jane/', title: 'jane on GitHub' },
  { url: 'https://jane.dev' }
]

describe('buildProposals', () => {
  it('diffs against current values, marks core writes, and verifies citations', () => {
    const proposals = buildProposals(
      { ...EMPTY_SNAPSHOT, org: 'ACME corp' }, // case-insensitively equal → dropped
      foundFindings(),
      SOURCES
    )
    const kinds = proposals.map((p) => p.kind)
    expect(kinds).toEqual(['jobTitle', 'bio', 'link', 'fact'])

    const jobTitle = proposals.find((p) => p.kind === 'jobTitle')
    expect(jobTitle?.writesToContact).toBe(true)
    expect(jobTitle?.sourceVerified).toBe(true) // acme.com/team is in SOURCES

    const link = proposals.find((p) => p.kind === 'link')
    expect(link?.sourceVerified).toBe(true) // trailing-slash difference still matches

    const fact = proposals.find((p) => p.kind === 'fact')
    expect(fact?.sourceVerified).toBe(false) // hallucinated citation
    expect(fact?.writesToContact).toBe(false)

    // Ids are stable indexes into the list.
    expect(proposals.map((p) => p.id)).toEqual([0, 1, 2, 3])
  })

  it('returns nothing for candidate/not_found findings', () => {
    expect(
      buildProposals(EMPTY_SNAPSHOT, { outcome: 'not_found', matchConfidence: 'low' }, [])
    ).toEqual([])
  })
})

describe('collectAcceptedFields + assembleWebEnrichment', () => {
  it('splits accepted ids into the core patch and the persisted namespace', () => {
    const proposals = buildProposals(EMPTY_SNAPSHOT, foundFindings(), SOURCES)
    // Accept jobTitle + link; reject org, bio, fact.
    const jobTitleId = proposals.find((p) => p.kind === 'jobTitle')?.id as number
    const linkId = proposals.find((p) => p.kind === 'link')?.id as number
    const accepted = new Set([jobTitleId, linkId])

    expect(collectAcceptedFields(proposals, accepted)).toEqual({ jobTitle: 'VP Engineering' })

    const web = assembleWebEnrichment(proposals, accepted, {
      searchedAs: 'Jane Doe (Acme Corp)',
      matchConfidence: 'high',
      sources: SOURCES,
      refreshedAt: 1_700_000_000_000,
      model: 'claude-test'
    })
    expect(web.links).toEqual([
      { type: 'github', value: 'https://github.com/jane', sourceUrl: 'https://github.com/jane' }
    ])
    expect(web.facts).toEqual([]) // rejected fact stays out
    expect(web.bio).toBeNull() // rejected bio stays out
    expect(web.sources).toEqual(SOURCES) // ground truth always kept
    expect(web.searchedAs).toBe('Jane Doe (Acme Corp)')
    expect(web.refreshedAt).toBe(1_700_000_000_000)
  })
})

describe('prompt builders', () => {
  it('includes only the provided identity fields', () => {
    const msg = buildWebEnrichUserMessage({
      displayName: 'Jane Doe',
      org: 'Acme',
      jobTitle: null,
      hints: 'lives in Austin',
      candidateHint: 'VP at Acme'
    })
    expect(msg).toContain('Name: Jane Doe')
    expect(msg).toContain('Organization: Acme')
    expect(msg).not.toContain('Job title')
    expect(msg).toContain('Extra context from the user: lives in Austin')
    expect(msg).toContain('The user confirmed the target is: VP at Acme')
  })

  it('buildSearchedAs composes a readable identity string', () => {
    expect(
      buildSearchedAs({ displayName: 'Jane Doe', org: 'Acme', jobTitle: 'VP', hints: 'Austin' })
    ).toBe('Jane Doe (VP, Acme) — Austin')
    expect(buildSearchedAs({ displayName: 'Jane Doe' })).toBe('Jane Doe')
  })
})
