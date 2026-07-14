/**
 * Merchant WEB enrichment — the pure core of "Enrich from web" for tracked
 * merchants, mirroring `contact-web-enrichment.ts` (the contacts original).
 *
 * Same trust model: runs only on an explicit button press behind a consent
 * dialog, uses Anthropic's SERVER-SIDE web_search (BYO key), and everything
 * the model returns is UNTRUSTED until the user reviews it — forced
 * structured output (`submit_merchant_findings`), hard validation with URL
 * sanitizing and length clamps, and citation verification against the URLs
 * the search actually returned.
 *
 * Merchant differences vs the contacts engine:
 *   - Core writes target the `places` row (url / category / address) plus
 *     `meta.support` (email / phone — customer-support contacts are public
 *     business info, the opposite of the contacts privacy rule).
 *   - The web namespace persists under `places.meta.enrichment`.
 *
 * PURE — no Electron, no Drizzle, type-only imports — unit-tests against
 * fixtures like its sibling.
 */

import type { AnthropicTool } from '../integrations/llm-client'
import type { WebFact, WebLink, WebSource } from './contact-enrichment'
import { type WebConfidence, sanitizeUrl } from './contact-web-enrichment'

// Reused verbatim from the contacts engine (same server tool, same source
// harvesting): WEB_SEARCH_TOOL + harvestSources are imported by the
// orchestrator directly from contact-web-enrichment.

/** What the orchestrator sends about the merchant (and nothing else). */
export interface MerchantWebEnrichInput {
  name: string
  category?: string | null
  address?: string | null
  url?: string | null
  /** Free-text disambiguation the user typed into the consent dialog. */
  hints?: string
  /** The candidate descriptor the user picked after an 'ambiguous' round. */
  candidateHint?: string
}

/** A scalar finding with its citation. */
export interface MerchantSourcedValue {
  value: string
  sourceUrl?: string
  confidence: WebConfidence
}

export interface MerchantWebCandidate {
  name: string
  descriptor: string
  sourceUrl?: string
}

/** The validated output of `submit_merchant_findings`. */
export interface ParsedMerchantFindings {
  outcome: 'found' | 'ambiguous' | 'not_found'
  matchConfidence: WebConfidence
  match?: {
    url?: MerchantSourcedValue
    category?: MerchantSourcedValue
    address?: MerchantSourcedValue
    supportEmail?: MerchantSourcedValue
    supportPhone?: MerchantSourcedValue
    description?: MerchantSourcedValue
    links: WebLink[]
    facts: WebFact[]
  }
  candidates?: MerchantWebCandidate[]
}

export type MerchantProposalKind =
  | 'url'
  | 'category'
  | 'address'
  | 'supportEmail'
  | 'supportPhone'
  | 'description'
  | 'link'
  | 'fact'

/** One reviewable proposal shown in the dialog. Ids index into the run's list. */
export interface MerchantWebProposal {
  id: number
  kind: MerchantProposalKind
  /** Display label — the link type for `kind: 'link'`. */
  label?: string
  /** The merchant's current value at run time (record fields only). */
  currentValue: string | null
  proposedValue: string
  sourceUrl?: string
  /** True when sourceUrl matches a URL the search actually returned. */
  sourceVerified: boolean
  confidence: WebConfidence
  /** True for url | category | address | supportEmail | supportPhone — the merchant-record writes. */
  writesToMerchant: boolean
}

/** The persisted `meta.enrichment` namespace on a places row. */
export interface MerchantWebEnrichment {
  searchedAs: string
  matchConfidence: WebConfidence
  description: string | null
  links: WebLink[]
  facts: WebFact[]
  /** Every page the search actually returned — citation ground truth. */
  sources: WebSource[]
  refreshedAt: number
  model?: string
}

// ---------------------------------------------------------------------------
// Prompt + tools
// ---------------------------------------------------------------------------

export const SUBMIT_MERCHANT_FINDINGS_TOOL_NAME = 'submit_merchant_findings'

const SOURCED_VALUE_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'string' },
    sourceUrl: { type: 'string', description: 'URL of the page that states this' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['value', 'confidence']
}

/**
 * The forced final call — the run ends when the model calls this (no
 * tool_result is ever sent back). Same rationale as the contacts engine.
 */
export const SUBMIT_MERCHANT_FINDINGS_TOOL: AnthropicTool = {
  name: SUBMIT_MERCHANT_FINDINGS_TOOL_NAME,
  description:
    'Submit your final findings about the business. Call exactly once, when done searching. ' +
    'Use outcome "found" with a match, "ambiguous" with candidates when multiple plausible ' +
    'businesses match, or "not_found".',
  input_schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['found', 'ambiguous', 'not_found'] },
      matchConfidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are that every finding is about the SAME, correct business'
      },
      match: {
        type: 'object',
        description: 'Only for outcome "found".',
        properties: {
          url: { ...SOURCED_VALUE_SCHEMA, description: 'Official website homepage' },
          category: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Short business category, e.g. "Coffee shop", "Streaming service"'
          },
          address: {
            ...SOURCED_VALUE_SCHEMA,
            description:
              'Street address of THIS location for a local business; omit for online-only'
          },
          supportEmail: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Customer-support email from an OFFICIAL page of the business'
          },
          supportPhone: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Customer-support phone from an OFFICIAL page of the business'
          },
          description: {
            ...SOURCED_VALUE_SCHEMA,
            description: '1-3 sentence factual summary of what the business is/sells'
          },
          links: {
            type: 'array',
            description:
              'Useful official pages: support/help center, cancellation page, returns policy, status page, social profiles',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description:
                    'support | cancellation | returns | status | social | other short label'
                },
                value: { type: 'string', description: 'The page URL' },
                sourceUrl: { type: 'string' }
              },
              required: ['value']
            }
          },
          facts: {
            type: 'array',
            description:
              'Notable public facts: return/refund policy summary, announced price changes, ownership, hours',
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
        description: 'Only for outcome "ambiguous": 2-5 distinct plausible businesses.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            descriptor: {
              type: 'string',
              description:
                'One line that tells them apart, e.g. "Coffee roaster chain, Oakland CA" vs "Cafe in Austin TX"'
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

export const MERCHANT_WEB_ENRICH_SYSTEM_PROMPT = `You are a careful business-researcher inside Compass, a private personal-finance app. Your job: find the PUBLIC web presence of ONE SPECIFIC business the user buys from, using the web_search tool, then report structured findings.

Identity rules:
- The target business is described in the user message — often as it appears on a bank statement, so the name may be truncated or noisy. Search for the real business behind it, refining queries with the provided category, address, and hints.
- If results contain multiple plausible businesses and the hints cannot distinguish them, you MUST use outcome "ambiguous" with 2-5 candidates, each with a one-line descriptor that tells them apart. NEVER guess, and never blend details from different businesses.
- If you find no credible public presence, use outcome "not_found".

Evidence rules:
- Report only claims that appear in pages returned by your searches, and put the URL of the page that states each claim in its sourceUrl.
- Do not infer, extrapolate, or fill gaps from general knowledge.
- confidence: "high" = stated clearly on the business's own site or an authoritative page; "medium" = likely but only one weak source; "low" = uncertain.

Scope rules — public business information only:
- In scope: official website, business category, the street address of the specific location (when it is a local business), customer-support email and phone FROM THE BUSINESS'S OWN pages, official support/cancellation/returns/status pages, social profiles, notable public facts (return policy, announced price changes, ownership, hours).
- Out of scope, never report: information about the business's individual employees or owners as private people, scraped customer reviews, anything from data-broker sites, or contact details from third-party directories that the business itself does not publish.

Output contract:
- When you are done searching, call ${SUBMIT_MERCHANT_FINDINGS_TOOL_NAME} EXACTLY ONCE with your findings. Do not write a prose answer. Keep description to 1-3 sentences.`

/** The canonical identity string — persisted as `searchedAs`. */
export function buildMerchantSearchedAs(input: MerchantWebEnrichInput): string {
  const paren = [input.category, input.address].filter((s): s is string => !!s?.trim()).join(', ')
  let out = input.name.trim()
  if (paren) out += ` (${paren})`
  if (input.hints?.trim()) out += ` — ${input.hints.trim()}`
  if (input.candidateHint?.trim()) out += ` — confirmed: ${input.candidateHint.trim()}`
  return out
}

export function buildMerchantWebEnrichUserMessage(input: MerchantWebEnrichInput): string {
  const lines = [
    'Find the public web presence of this business:',
    '',
    `Name (as it appears in my records): ${input.name.trim()}`
  ]
  if (input.category?.trim()) lines.push(`Category: ${input.category.trim()}`)
  if (input.address?.trim()) lines.push(`Known address: ${input.address.trim()}`)
  if (input.url?.trim()) lines.push(`Known website: ${input.url.trim()}`)
  if (input.hints?.trim()) lines.push(`Extra context from the user: ${input.hints.trim()}`)
  if (input.candidateHint?.trim())
    lines.push(`The user confirmed the target is: ${input.candidateHint.trim()}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Defensive validation
// ---------------------------------------------------------------------------

const MAX_VALUE = 2000
const MAX_CATEGORY = 200
const MAX_ADDRESS = 500
const MAX_EMAIL = 200
const MAX_PHONE = 50
const MAX_DESCRIPTION = 2000
const MAX_FACT = 1000
const MAX_LINKS = 15
const MAX_FACTS = 20
const MAX_CANDIDATES = 5
/** Deliberately loose — we only need "shaped like an email", the user reviews it. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function asTrimmed(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function asConfidence(v: unknown): WebConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium'
}

function asSourcedValue(v: unknown, max = MAX_VALUE): MerchantSourcedValue | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const value = asTrimmed(o.value, max)
  if (!value) return undefined
  return { value, sourceUrl: sanitizeUrl(o.sourceUrl), confidence: asConfidence(o.confidence) }
}

/**
 * Validate the raw `submit_merchant_findings` input. Returns null when the
 * payload is structurally unusable; otherwise a fully-clamped
 * `ParsedMerchantFindings` (individual bad items are dropped, not fatal).
 */
export function parseMerchantSubmitPayload(input: unknown): ParsedMerchantFindings | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const outcome = o.outcome
  if (outcome !== 'found' && outcome !== 'ambiguous' && outcome !== 'not_found') return null
  const matchConfidence = asConfidence(o.matchConfidence)

  if (outcome === 'ambiguous') {
    const raw = Array.isArray(o.candidates) ? o.candidates : []
    const candidates: MerchantWebCandidate[] = []
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
  const match: NonNullable<ParsedMerchantFindings['match']> = { links: [], facts: [] }

  match.category = asSourcedValue(m.category, MAX_CATEGORY)
  match.address = asSourcedValue(m.address, MAX_ADDRESS)
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

  // Support email must be shaped like an email; otherwise survive as a fact.
  const email = asSourcedValue(m.supportEmail, MAX_EMAIL)
  if (email && EMAIL_RE.test(email.value)) match.supportEmail = email
  else if (email)
    match.facts.push({
      text: `Support contact (unparsed): ${email.value}`,
      sourceUrl: email.sourceUrl,
      confidence: email.confidence
    })

  match.supportPhone = asSourcedValue(m.supportPhone, MAX_PHONE)

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
    match.url ||
    match.category ||
    match.address ||
    match.supportEmail ||
    match.supportPhone ||
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
export function parseMerchantFindingsFromText(text: string): ParsedMerchantFindings | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return parseMerchantSubmitPayload(JSON.parse(text.slice(start, i + 1)))
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

/** The current merchant-record values a proposal diffs against. */
export interface MerchantWebSnapshot {
  url: string | null
  category: string | null
  address: string | null
  supportEmail: string | null
  supportPhone: string | null
}

const sameValue = (a: string | null, b: string): boolean =>
  (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Turn validated findings into the reviewable proposal list. Proposals equal
 * to the current value are dropped; `sourceVerified` cross-checks each
 * citation against the harvested sources.
 */
export function buildMerchantProposals(
  merchant: MerchantWebSnapshot,
  findings: ParsedMerchantFindings,
  sources: WebSource[]
): MerchantWebProposal[] {
  const match = findings.match
  if (!match) return []
  const sourceKeys = new Set(sources.map((s) => urlKey(s.url)))
  const verified = (sourceUrl?: string): boolean => !!sourceUrl && sourceKeys.has(urlKey(sourceUrl))

  const out: MerchantWebProposal[] = []
  const push = (p: Omit<MerchantWebProposal, 'id' | 'sourceVerified'>): void => {
    out.push({ ...p, id: out.length, sourceVerified: verified(p.sourceUrl) })
  }

  const record: Array<
    [
      'url' | 'category' | 'address' | 'supportEmail' | 'supportPhone',
      MerchantSourcedValue | undefined
    ]
  > = [
    ['url', match.url],
    ['category', match.category],
    ['address', match.address],
    ['supportEmail', match.supportEmail],
    ['supportPhone', match.supportPhone]
  ]
  for (const [kind, sv] of record) {
    if (!sv || sameValue(merchant[kind], sv.value)) continue
    push({
      kind,
      currentValue: merchant[kind],
      proposedValue: sv.value,
      sourceUrl: sv.sourceUrl,
      confidence: sv.confidence,
      writesToMerchant: true
    })
  }

  if (match.description)
    push({
      kind: 'description',
      currentValue: null,
      proposedValue: match.description.value,
      sourceUrl: match.description.sourceUrl,
      confidence: match.description.confidence,
      writesToMerchant: false
    })
  for (const link of match.links)
    push({
      kind: 'link',
      label: link.type,
      currentValue: null,
      proposedValue: link.value,
      sourceUrl: link.sourceUrl,
      confidence: 'medium',
      writesToMerchant: false
    })
  for (const fact of match.facts)
    push({
      kind: 'fact',
      currentValue: null,
      proposedValue: fact.text,
      sourceUrl: fact.sourceUrl,
      confidence: fact.confidence,
      writesToMerchant: false
    })
  return out
}

export type MerchantAcceptedFields = Partial<
  Record<'url' | 'category' | 'address' | 'supportEmail' | 'supportPhone', string>
>

/** The accepted merchant-record patch for `applyMerchantWebEnrichment`. */
export function collectMerchantAcceptedFields(
  proposals: MerchantWebProposal[],
  acceptedIds: Set<number>
): MerchantAcceptedFields {
  const fields: MerchantAcceptedFields = {}
  for (const p of proposals) {
    if (!p.writesToMerchant || !acceptedIds.has(p.id)) continue
    if (p.kind !== 'description' && p.kind !== 'link' && p.kind !== 'fact')
      fields[p.kind] = p.proposedValue
  }
  return fields
}

/**
 * Build the persisted `meta.enrichment` namespace from the ACCEPTED proposals.
 * Sources are always kept in full — citation ground truth, not user data to
 * cherry-pick. A re-run replaces the whole namespace, so rejected leftovers
 * never linger.
 */
export function assembleMerchantWebEnrichment(
  proposals: MerchantWebProposal[],
  acceptedIds: Set<number>,
  meta: {
    searchedAs: string
    matchConfidence: WebConfidence
    sources: WebSource[]
    refreshedAt: number
    model?: string
  }
): MerchantWebEnrichment {
  const links: WebLink[] = []
  const facts: WebFact[] = []
  let description: string | null = null
  for (const p of proposals) {
    if (!acceptedIds.has(p.id)) continue
    if (p.kind === 'link')
      links.push({ type: p.label, value: p.proposedValue, sourceUrl: p.sourceUrl })
    else if (p.kind === 'fact')
      facts.push({ text: p.proposedValue, sourceUrl: p.sourceUrl, confidence: p.confidence })
    else if (p.kind === 'description') description = p.proposedValue
  }
  return {
    searchedAs: meta.searchedAs,
    matchConfidence: meta.matchConfidence,
    description,
    links,
    facts,
    sources: meta.sources,
    refreshedAt: meta.refreshedAt,
    model: meta.model
  }
}
