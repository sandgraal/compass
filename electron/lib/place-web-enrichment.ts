/**
 * Place WEB enrichment — the pure core of "Enrich from web" for tracked
 * places AND tracked merchants (both are rows in the shared `places` table).
 * The place-flavored sibling of contact-web-enrichment.ts (PR #395): same
 * trust model, same defensive jobs —
 *   1. Force structured output via a final client-tool call.
 *   2. Validate hard (clamp lengths, drop unsafe URLs, demote malformed
 *      values to plain facts).
 *   3. Verify citations against the URLs the search actually returned.
 * The generic machinery (web_search tool config, URL sanitizing, source
 * harvesting) is imported from the contact engine rather than re-implemented,
 * so the two flows can never drift on safety behavior.
 *
 * PURE — no Electron, no Drizzle, type-only llm imports — unit-tests against
 * fixtures like its siblings.
 */

import type { WebFact, WebLink, WebSource } from './contact-enrichment'
import {
  type SourcedValue,
  type WebCandidate,
  type WebConfidence,
  harvestSources,
  sanitizeUrl
} from './contact-web-enrichment'

export { WEB_SEARCH_TOOL } from './contact-web-enrichment'
export { harvestSources, sanitizeUrl }
export type { WebCandidate, WebConfidence }

import type { AnthropicTool } from '../integrations/llm-client'

/** What the orchestrator sends about the place (and nothing else). */
export interface PlaceWebEnrichInput {
  name: string
  category?: string | null
  address?: string | null
  /** 'place' | 'merchant' — phrasing only; both search the same way. */
  kind: string
  /** Free-text disambiguation the user typed into the consent dialog. */
  hints?: string
  /** The candidate descriptor the user picked after an 'ambiguous' round. */
  candidateHint?: string
}

/** The validated output of `submit_place_findings`. */
export interface ParsedPlaceWebFindings {
  outcome: 'found' | 'ambiguous' | 'not_found'
  matchConfidence: WebConfidence
  match?: {
    category?: SourcedValue
    address?: SourcedValue
    url?: SourcedValue
    phone?: SourcedValue
    hours?: SourcedValue
    description?: SourcedValue
    links: WebLink[]
    facts: WebFact[]
  }
  candidates?: WebCandidate[]
}

/** One reviewable proposal shown in the dialog. Ids index into the run's list. */
export interface PlaceWebEnrichProposal {
  id: number
  kind: 'category' | 'address' | 'url' | 'phone' | 'hours' | 'description' | 'link' | 'fact'
  /** Display label — the link type for `kind: 'link'`. */
  label?: string
  /** The place's current value at run time (core fields only). */
  currentValue: string | null
  proposedValue: string
  sourceUrl?: string
  /** True when sourceUrl matches a URL the search actually returned. */
  sourceVerified: boolean
  confidence: WebConfidence
  /** True only for category | address | url — the core-column writes. */
  writesToPlace: boolean
}

/** The persisted `meta.enrichment.web` namespace (accepted findings only). */
export interface PlaceWebEnrichment {
  searchedAs: string
  matchConfidence: WebConfidence
  description: string | null
  phone: string | null
  hours: string | null
  links: WebLink[]
  facts: WebFact[]
  sources: WebSource[]
  refreshedAt: number
  model?: string
}

// ---------------------------------------------------------------------------
// Prompt + tools
// ---------------------------------------------------------------------------

export const SUBMIT_PLACE_FINDINGS_TOOL_NAME = 'submit_place_findings'

const SOURCED_VALUE_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'string' },
    sourceUrl: { type: 'string', description: 'URL of the page that states this' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['value', 'confidence']
}

/** The forced final call — the run ends when the model calls this. */
export const SUBMIT_PLACE_FINDINGS_TOOL: AnthropicTool = {
  name: SUBMIT_PLACE_FINDINGS_TOOL_NAME,
  description:
    'Submit your final findings about the place. Call exactly once, when done searching. ' +
    'Use outcome "found" with a match, "ambiguous" with candidates when multiple plausible ' +
    'places match (e.g. chain locations), or "not_found".',
  input_schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['found', 'ambiguous', 'not_found'] },
      matchConfidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are that every finding is about the SAME, correct place'
      },
      match: {
        type: 'object',
        description: 'Only for outcome "found".',
        properties: {
          category: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Business type in 1-3 words, e.g. "Coffee shop", "CrossFit gym"'
          },
          address: { ...SOURCED_VALUE_SCHEMA, description: 'Street address of THIS location' },
          url: { ...SOURCED_VALUE_SCHEMA, description: 'Official website' },
          phone: { ...SOURCED_VALUE_SCHEMA, description: 'Public business phone number' },
          hours: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Opening hours, compact one-liner, e.g. "Mon–Sat 6:00–20:00"'
          },
          description: { ...SOURCED_VALUE_SCHEMA, description: '2-3 sentence description' },
          links: {
            type: 'array',
            description: 'Official profiles: Instagram, Facebook, X, maps listing, …',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description: 'instagram | facebook | x | maps | other short label'
                },
                value: { type: 'string', description: 'The profile URL' },
                sourceUrl: { type: 'string' }
              },
              required: ['value']
            }
          },
          facts: {
            type: 'array',
            description: 'Notable public facts: press coverage, awards, history, specialties',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                sourceUrl: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
              },
              required: ['text']
            }
          }
        }
      },
      candidates: {
        type: 'array',
        description: 'Only for outcome "ambiguous": 2-5 distinct plausible places.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            descriptor: {
              type: 'string',
              description: 'One line that tells them apart, e.g. "the Cartago location on Av. 2"'
            },
            sourceUrl: { type: 'string' }
          },
          required: ['name', 'descriptor']
        }
      }
    },
    required: ['outcome', 'matchConfidence']
  }
}

export const PLACE_WEB_ENRICH_SYSTEM_PROMPT = `You are a careful researcher inside Compass, a private personal life-OS app. Your job: find the PUBLIC web presence of ONE SPECIFIC place or business the user already knows, using the web_search tool, then report structured findings.

Identity rules:
- The target place is described in the user message. Search for it specifically, refining queries with the provided address, category, and hints.
- If results contain multiple plausible places (e.g. several locations of a chain) and the hints cannot distinguish them, you MUST use outcome "ambiguous" with 2-5 candidates, each with a one-line descriptor that tells them apart. NEVER guess, and never blend details from different locations.
- If the place appears to be a private residence, or you find no credible public presence, use outcome "not_found".

Evidence rules:
- Report only claims that appear in pages returned by your searches, and put the URL of the page that states each claim in its sourceUrl.
- Do not infer, extrapolate, or fill gaps from general knowledge.
- confidence: "high" = stated clearly on the business's own site or an authoritative listing; "medium" = likely but only one weak source; "low" = uncertain.

Scope rules — public business information only:
- In scope: official website, business category, street address, public business phone, opening hours, a short description, official social profiles (Instagram, Facebook, X, maps listing), notable press coverage.
- Out of scope, never report: information about private individuals (owners' or staff members' personal details), residential addresses of people, and anything from data-broker / people-search sites.

Output contract:
- When you are done searching, call ${SUBMIT_PLACE_FINDINGS_TOOL_NAME} EXACTLY ONCE with your findings. Do not write a prose answer. Keep the description to 2-3 sentences.`

/** The canonical identity string — persisted as `searchedAs`. */
export function buildPlaceSearchedAs(input: PlaceWebEnrichInput): string {
  const paren = [input.category, input.address].filter((s): s is string => !!s?.trim()).join(', ')
  let out = input.name.trim()
  if (paren) out += ` (${paren})`
  if (input.hints?.trim()) out += ` — ${input.hints.trim()}`
  if (input.candidateHint?.trim()) out += ` — confirmed: ${input.candidateHint.trim()}`
  return out
}

export function buildPlaceWebEnrichUserMessage(input: PlaceWebEnrichInput): string {
  const noun = input.kind === 'merchant' ? 'business' : 'place'
  const lines = [`Find the public web presence of this ${noun}:`, '', `Name: ${input.name.trim()}`]
  if (input.category?.trim()) lines.push(`Category: ${input.category.trim()}`)
  if (input.address?.trim()) lines.push(`Known address: ${input.address.trim()}`)
  if (input.hints?.trim()) lines.push(`Extra context from the user: ${input.hints.trim()}`)
  if (input.candidateHint?.trim())
    lines.push(`The user confirmed the target is: ${input.candidateHint.trim()}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Defensive validation
// ---------------------------------------------------------------------------

const MAX_VALUE = 2000
const MAX_DESCRIPTION = 4000
const MAX_FACT = 1000
const MAX_LINKS = 15
const MAX_FACTS = 20
const MAX_CANDIDATES = 5

function asTrimmed(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function asConfidence(v: unknown): WebConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium'
}

function asSourcedValue(v: unknown, max = MAX_VALUE): SourcedValue | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const value = asTrimmed(o.value, max)
  if (!value) return undefined
  return { value, sourceUrl: sanitizeUrl(o.sourceUrl), confidence: asConfidence(o.confidence) }
}

/**
 * Validate the raw `submit_place_findings` input. Returns null when the
 * payload is structurally unusable; otherwise a fully-clamped findings object
 * (individual bad items are dropped, not fatal).
 */
export function parsePlaceSubmitPayload(input: unknown): ParsedPlaceWebFindings | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const outcome = o.outcome
  if (outcome !== 'found' && outcome !== 'ambiguous' && outcome !== 'not_found') return null
  const matchConfidence = asConfidence(o.matchConfidence)

  if (outcome === 'ambiguous') {
    const raw = Array.isArray(o.candidates) ? o.candidates : []
    const candidates: WebCandidate[] = []
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue
      const co = c as Record<string, unknown>
      const name = asTrimmed(co.name, 200)
      const descriptor = asTrimmed(co.descriptor, 300)
      if (!name || !descriptor) continue
      candidates.push({ name, descriptor, sourceUrl: sanitizeUrl(co.sourceUrl) })
      if (candidates.length >= MAX_CANDIDATES) break
    }
    if (candidates.length === 0) return null
    return { outcome, matchConfidence, candidates }
  }

  if (outcome === 'not_found') return { outcome, matchConfidence }

  // outcome === 'found'
  const m = o.match && typeof o.match === 'object' ? (o.match as Record<string, unknown>) : {}
  const match: NonNullable<ParsedPlaceWebFindings['match']> = { links: [], facts: [] }

  match.category = asSourcedValue(m.category, 200)
  match.address = asSourcedValue(m.address, 500)
  match.phone = asSourcedValue(m.phone, 50)
  match.hours = asSourcedValue(m.hours, 500)
  match.description = asSourcedValue(m.description, MAX_DESCRIPTION)

  // The url field must itself be a safe URL; otherwise demote to a fact.
  const url = asSourcedValue(m.url)
  if (url) {
    const safe = sanitizeUrl(url.value)
    if (safe) match.url = { ...url, value: safe }
    else
      match.facts.push({
        text: `Website (unparsed): ${url.value}`,
        sourceUrl: url.sourceUrl,
        confidence: url.confidence
      })
  }

  for (const l of Array.isArray(m.links) ? m.links : []) {
    if (!l || typeof l !== 'object') continue
    const lo = l as Record<string, unknown>
    const value = sanitizeUrl(lo.value)
    if (!value) continue
    match.links.push({
      type: asTrimmed(lo.type, 40) ?? undefined,
      value,
      sourceUrl: sanitizeUrl(lo.sourceUrl)
    })
    if (match.links.length >= MAX_LINKS) break
  }

  for (const f of Array.isArray(m.facts) ? m.facts : []) {
    if (match.facts.length >= MAX_FACTS) break
    if (!f || typeof f !== 'object') continue
    const fo = f as Record<string, unknown>
    const text = asTrimmed(fo.text, MAX_FACT)
    if (!text) continue
    match.facts.push({
      text,
      sourceUrl: sanitizeUrl(fo.sourceUrl),
      confidence: asConfidence(fo.confidence)
    })
  }

  const hasAnything =
    match.category ||
    match.address ||
    match.url ||
    match.phone ||
    match.hours ||
    match.description ||
    match.links.length > 0 ||
    match.facts.length > 0
  if (!hasAnything) return { outcome: 'not_found', matchConfidence }

  return { outcome, matchConfidence, match }
}

/**
 * Fallback for runs that end with prose instead of the tool call: pull the
 * first balanced {...} out of the text and run it through the same validator.
 */
export function parsePlaceFindingsFromText(text: string): ParsedPlaceWebFindings | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return parsePlaceSubmitPayload(JSON.parse(text.slice(start, i + 1)))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/** Normalize for citation matching only (never for display/storage). */
function urlKey(u: string): string {
  return u.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '')
}

/** The current core-column values a proposal diffs against. */
export interface PlaceWebEnrichSnapshot {
  category: string | null
  address: string | null
  url: string | null
}

const sameValue = (a: string | null, b: string): boolean =>
  (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Turn validated findings into the reviewable proposal list. Proposals equal
 * to the current value are dropped; `sourceVerified` cross-checks each
 * citation against the harvested sources.
 */
export function buildPlaceProposals(
  place: PlaceWebEnrichSnapshot,
  findings: ParsedPlaceWebFindings,
  sources: WebSource[]
): PlaceWebEnrichProposal[] {
  const match = findings.match
  if (!match) return []
  const sourceKeys = new Set(sources.map((s) => urlKey(s.url)))
  const verified = (sourceUrl?: string): boolean => !!sourceUrl && sourceKeys.has(urlKey(sourceUrl))

  const out: PlaceWebEnrichProposal[] = []
  const push = (p: Omit<PlaceWebEnrichProposal, 'id' | 'sourceVerified'>): void => {
    out.push({ ...p, id: out.length, sourceVerified: verified(p.sourceUrl) })
  }

  const core: Array<['category' | 'address' | 'url', SourcedValue | undefined]> = [
    ['category', match.category],
    ['address', match.address],
    ['url', match.url]
  ]
  for (const [kind, sv] of core) {
    if (!sv || sameValue(place[kind], sv.value)) continue
    push({
      kind,
      currentValue: place[kind],
      proposedValue: sv.value,
      sourceUrl: sv.sourceUrl,
      confidence: sv.confidence,
      writesToPlace: true
    })
  }

  const extras: Array<['phone' | 'hours' | 'description', SourcedValue | undefined]> = [
    ['phone', match.phone],
    ['hours', match.hours],
    ['description', match.description]
  ]
  for (const [kind, sv] of extras) {
    if (!sv) continue
    push({
      kind,
      currentValue: null,
      proposedValue: sv.value,
      sourceUrl: sv.sourceUrl,
      confidence: sv.confidence,
      writesToPlace: false
    })
  }
  for (const link of match.links)
    push({
      kind: 'link',
      label: link.type,
      currentValue: null,
      proposedValue: link.value,
      sourceUrl: link.sourceUrl,
      confidence: 'medium',
      writesToPlace: false
    })
  for (const fact of match.facts)
    push({
      kind: 'fact',
      currentValue: null,
      proposedValue: fact.text,
      sourceUrl: fact.sourceUrl,
      confidence: fact.confidence,
      writesToPlace: false
    })
  return out
}

/** The accepted core-column patch for the apply step. */
export function collectAcceptedPlaceFields(
  proposals: PlaceWebEnrichProposal[],
  acceptedIds: Set<number>
): Partial<Record<'category' | 'address' | 'url', string>> {
  const fields: Partial<Record<'category' | 'address' | 'url', string>> = {}
  for (const p of proposals) {
    if (!p.writesToPlace || !acceptedIds.has(p.id)) continue
    if (p.kind === 'category' || p.kind === 'address' || p.kind === 'url')
      fields[p.kind] = p.proposedValue
  }
  return fields
}

/**
 * Build the persisted `web` namespace from the ACCEPTED proposals. Sources are
 * always kept in full — they are the citation ground truth, not user data to
 * cherry-pick. A re-run replaces the whole namespace, so rejected leftovers
 * never linger.
 */
export function assemblePlaceWebEnrichment(
  proposals: PlaceWebEnrichProposal[],
  acceptedIds: Set<number>,
  meta: {
    searchedAs: string
    matchConfidence: WebConfidence
    sources: WebSource[]
    refreshedAt: number
    model?: string
  }
): PlaceWebEnrichment {
  const links: WebLink[] = []
  const facts: WebFact[] = []
  let description: string | null = null
  let phone: string | null = null
  let hours: string | null = null
  for (const p of proposals) {
    if (!acceptedIds.has(p.id)) continue
    if (p.kind === 'link')
      links.push({ type: p.label, value: p.proposedValue, sourceUrl: p.sourceUrl })
    else if (p.kind === 'fact')
      facts.push({ text: p.proposedValue, sourceUrl: p.sourceUrl, confidence: p.confidence })
    else if (p.kind === 'description') description = p.proposedValue
    else if (p.kind === 'phone') phone = p.proposedValue
    else if (p.kind === 'hours') hours = p.proposedValue
  }
  return {
    searchedAs: meta.searchedAs,
    matchConfidence: meta.matchConfidence,
    description,
    phone,
    hours,
    links,
    facts,
    sources: meta.sources,
    refreshedAt: meta.refreshedAt,
    model: meta.model
  }
}
