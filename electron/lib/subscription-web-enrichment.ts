/**
 * Subscription WEB enrichment — the subscription-flavored sibling of
 * `place-web-enrichment.ts` (itself a sibling of `contact-web-enrichment.ts`,
 * PR #395). Same trust model, same defensive jobs:
 *   1. Force structured output via a final client-tool call.
 *   2. Validate hard (clamp lengths, drop unsafe URLs, demote malformed
 *      values to plain facts).
 *   3. Verify citations against the URLs the search actually returned.
 * The generic machinery (web_search tool config, URL sanitizing, source
 * harvesting) is imported from the contact engine rather than re-implemented,
 * so all three enrichment flows can never drift on safety behavior.
 *
 * What's different here vs. places/merchants: the question isn't "what is
 * this business" (address/phone/hours) but "should I keep paying for this" —
 * pricing & plan tiers, whether annual billing is cheaper, what's included,
 * how to cancel (steps + the direct URL), comparable alternatives, and the
 * support contact. `PlaceWebEnrichment` has no fields for any of that, so a
 * linked merchant's enrichment can inform this search (as a hint) but can
 * never substitute for it.
 *
 * PURE — no Electron, no Drizzle, type-only llm imports — unit-tests against
 * fixtures like its siblings.
 */

import type { WebFact, WebSource } from './contact-enrichment'
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

/** What the orchestrator sends about the subscription (and nothing else — never notes). */
export interface SubscriptionWebEnrichInput {
  name: string
  category?: string | null
  cost: number
  cadence: string
  /** A linked merchant's own site, if already known — a search hint, not a substitute. */
  knownUrlHint?: string | null
  /** Free-text disambiguation the user typed into the consent dialog. */
  hints?: string
  /** The candidate descriptor the user picked after an 'ambiguous' round. */
  candidateHint?: string
}

export interface SubscriptionPlanFinding {
  name: string
  price: string
  cadence?: string
  note?: string
  sourceUrl?: string
}

export interface SubscriptionAlternativeFinding {
  name: string
  note: string
  approxPrice?: string
  sourceUrl?: string
}

/** The validated output of `submit_subscription_findings`. */
export interface ParsedSubscriptionWebFindings {
  outcome: 'found' | 'ambiguous' | 'not_found'
  matchConfidence: WebConfidence
  match?: {
    pricingSummary?: SourcedValue
    annualDiscount?: SourcedValue
    plans: SubscriptionPlanFinding[]
    benefits: WebFact[]
    cancellationSteps?: SourcedValue
    cancellationUrl?: SourcedValue
    alternatives: SubscriptionAlternativeFinding[]
    supportUrl?: SourcedValue
  }
  candidates?: WebCandidate[]
}

/** One reviewable proposal shown in the dialog. Ids index into the run's list. */
export interface SubscriptionWebEnrichProposal {
  id: number
  kind:
    | 'pricing'
    | 'planTier'
    | 'annualSavings'
    | 'benefit'
    | 'cancellationSteps'
    | 'cancellationUrl'
    | 'supportUrl'
    | 'alternative'
  /** Display label — the plan/alternative name for those kinds. */
  label?: string
  /** The subscription's current value at run time — only `cancellationUrl` has one. */
  currentValue: string | null
  proposedValue: string
  sourceUrl?: string
  /** True when sourceUrl matches a URL the search actually returned. */
  sourceVerified: boolean
  confidence: WebConfidence
  /** True only for `cancellationUrl` — the one core-column write (`cancelUrl`). */
  writesToSubscription: boolean
}

/** The persisted `meta.enrichment.web` namespace (accepted findings only). */
export interface SubscriptionWebEnrichment {
  searchedAs: string
  matchConfidence: WebConfidence
  pricingSummary: string | null
  annualDiscount: string | null
  plans: Array<{ name: string; detail: string; sourceUrl?: string }>
  benefits: WebFact[]
  cancellationSteps: string | null
  cancellationUrl: string | null
  alternatives: Array<{ name: string; note: string; sourceUrl?: string }>
  supportUrl: string | null
  sources: WebSource[]
  refreshedAt: number
  model?: string
}

// ---------------------------------------------------------------------------
// Prompt + tools
// ---------------------------------------------------------------------------

export const SUBMIT_SUBSCRIPTION_FINDINGS_TOOL_NAME = 'submit_subscription_findings'

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
export const SUBMIT_SUBSCRIPTION_FINDINGS_TOOL: AnthropicTool = {
  name: SUBMIT_SUBSCRIPTION_FINDINGS_TOOL_NAME,
  description:
    'Submit your final findings about the subscription service. Call exactly once, when done ' +
    'searching. Use outcome "found" with a match, "ambiguous" with candidates when multiple ' +
    'distinct services share a similar name, or "not_found".',
  input_schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['found', 'ambiguous', 'not_found'] },
      matchConfidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are every finding is about the SAME, correct service'
      },
      match: {
        type: 'object',
        description: 'Only for outcome "found".',
        properties: {
          pricingSummary: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Current price in one short sentence, e.g. "$9.99/month, or $99.99/year"'
          },
          annualDiscount: {
            ...SOURCED_VALUE_SCHEMA,
            description:
              'Savings from paying annually instead of monthly, if any, e.g. "~17% cheaper billed annually"'
          },
          plans: {
            type: 'array',
            description: 'Pricing tiers/plans this service currently offers',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Tier name, e.g. "Premium"' },
                price: { type: 'string', description: 'e.g. "$14.99/month"' },
                cadence: { type: 'string', description: 'e.g. "monthly", "annual" — optional' },
                note: { type: 'string', description: 'One-line what you get at this tier' },
                sourceUrl: { type: 'string' }
              },
              required: ['name', 'price']
            }
          },
          benefits: {
            type: 'array',
            description: 'What you get / key features included with the current plan',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                sourceUrl: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
              },
              required: ['text']
            }
          },
          cancellationSteps: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Short plain-text numbered steps for how to cancel (no markdown headers)'
          },
          cancellationUrl: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Direct URL to the cancellation or account-management page'
          },
          alternatives: {
            type: 'array',
            description: 'Comparable competitor services worth considering instead',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                note: { type: 'string', description: 'One line on how it compares' },
                approxPrice: { type: 'string' },
                sourceUrl: { type: 'string' }
              },
              required: ['name', 'note']
            }
          },
          supportUrl: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Official support / help-center URL'
          }
        }
      },
      candidates: {
        type: 'array',
        description: 'Only for outcome "ambiguous": 2-5 distinct plausible services.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            descriptor: {
              type: 'string',
              description:
                'One line that tells them apart, e.g. "the enterprise/B2B product, not the consumer app"'
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

export const SUBSCRIPTION_WEB_ENRICH_SYSTEM_PROMPT = `You are a careful researcher inside Compass, a private personal life-OS app. Your job: find PUBLIC information about ONE SPECIFIC subscription service the user already pays for, using the web_search tool, then report structured findings to help them decide whether to keep it.

Identity rules:
- The target service is described in the user message. Search for it specifically, refining queries with the provided category, cost/cadence, and hints.
- If results contain multiple plausible distinct services with a similar name and the hints cannot distinguish them, you MUST use outcome "ambiguous" with 2-5 candidates, each with a one-line descriptor that tells them apart. NEVER guess, and never blend details from different services.
- If you find no credible public presence, use outcome "not_found".

Evidence rules:
- Report only claims that appear in pages returned by your searches, and put the URL of the page that states each claim in its sourceUrl.
- Do not infer, extrapolate, or fill gaps from general knowledge — pricing and plans change often.
- confidence: "high" = stated clearly on the service's own pricing/help page; "medium" = likely but only one weaker source; "low" = uncertain.

Scope rules — public product/pricing information only:
- In scope: current pricing and plan tiers, whether annual billing is cheaper than monthly, what's included / key features, how to cancel (plain-text steps and the direct cancellation/account-management URL), the official support/help URL, and comparable alternative services worth considering.
- Out of scope, never report: anything about the user's own account, billing history, or personal data — you have no access to that and must never imply otherwise.

Output contract:
- When you are done searching, call ${SUBMIT_SUBSCRIPTION_FINDINGS_TOOL_NAME} EXACTLY ONCE with your findings. Do not write a prose answer. Keep cancellationSteps to a short plain-text numbered list, no markdown headers.`

/** The canonical identity string — persisted as `searchedAs`. */
export function buildSubscriptionSearchedAs(input: SubscriptionWebEnrichInput): string {
  const parts: string[] = []
  if (input.category?.trim()) parts.push(input.category.trim())
  parts.push(`${input.cadence}, ~${input.cost}`)
  let out = input.name.trim()
  if (parts.length > 0) out += ` (${parts.join(', ')})`
  if (input.hints?.trim()) out += ` — ${input.hints.trim()}`
  if (input.candidateHint?.trim()) out += ` — confirmed: ${input.candidateHint.trim()}`
  return out
}

export function buildSubscriptionWebEnrichUserMessage(input: SubscriptionWebEnrichInput): string {
  const lines = [
    'Find public pricing, plans, cancellation, and alternatives info for this subscription service:',
    '',
    `Name: ${input.name.trim()}`
  ]
  if (input.category?.trim()) lines.push(`Category: ${input.category.trim()}`)
  lines.push(`What the user currently pays: ~${input.cost} per ${input.cadence}`)
  if (input.knownUrlHint?.trim()) lines.push(`Known official site: ${input.knownUrlHint.trim()}`)
  if (input.hints?.trim()) lines.push(`Extra context from the user: ${input.hints.trim()}`)
  if (input.candidateHint?.trim())
    lines.push(`The user confirmed the target is: ${input.candidateHint.trim()}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Defensive validation
// ---------------------------------------------------------------------------

const MAX_VALUE = 2000
const MAX_STEPS = 3000
const MAX_FACT = 1000
const MAX_PLAN_NAME = 200
const MAX_PLAN_PRICE = 100
const MAX_PLAN_CADENCE = 40
const MAX_PLAN_NOTE = 500
const MAX_ALT_NAME = 200
const MAX_ALT_NOTE = 500
const MAX_ALT_PRICE = 100
const MAX_PLANS = 8
const MAX_BENEFITS = 12
const MAX_ALTERNATIVES = 6
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

function asPlanTier(v: unknown): SubscriptionPlanFinding | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const name = asTrimmed(o.name, MAX_PLAN_NAME)
  const price = asTrimmed(o.price, MAX_PLAN_PRICE)
  if (!name || !price) return null
  return {
    name,
    price,
    cadence: asTrimmed(o.cadence, MAX_PLAN_CADENCE) ?? undefined,
    note: asTrimmed(o.note, MAX_PLAN_NOTE) ?? undefined,
    sourceUrl: sanitizeUrl(o.sourceUrl)
  }
}

function asAlternative(v: unknown): SubscriptionAlternativeFinding | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const name = asTrimmed(o.name, MAX_ALT_NAME)
  const note = asTrimmed(o.note, MAX_ALT_NOTE)
  if (!name || !note) return null
  return {
    name,
    note,
    approxPrice: asTrimmed(o.approxPrice, MAX_ALT_PRICE) ?? undefined,
    sourceUrl: sanitizeUrl(o.sourceUrl)
  }
}

/**
 * Validate the raw `submit_subscription_findings` input. Returns null when
 * the payload is structurally unusable; otherwise a fully-clamped findings
 * object (individual bad items are dropped, not fatal).
 */
export function parseSubscriptionSubmitPayload(
  input: unknown
): ParsedSubscriptionWebFindings | null {
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
  const match: NonNullable<ParsedSubscriptionWebFindings['match']> = {
    plans: [],
    benefits: [],
    alternatives: []
  }

  match.pricingSummary = asSourcedValue(m.pricingSummary)
  match.annualDiscount = asSourcedValue(m.annualDiscount)
  match.cancellationSteps = asSourcedValue(m.cancellationSteps, MAX_STEPS)

  // URL fields must themselves be safe URLs; otherwise demote to a benefit fact.
  const cancellationUrl = asSourcedValue(m.cancellationUrl)
  if (cancellationUrl) {
    const safe = sanitizeUrl(cancellationUrl.value)
    if (safe) match.cancellationUrl = { ...cancellationUrl, value: safe }
    else
      match.benefits.push({
        text: `Cancellation page (unparsed): ${cancellationUrl.value}`,
        sourceUrl: cancellationUrl.sourceUrl,
        confidence: cancellationUrl.confidence
      })
  }

  const supportUrl = asSourcedValue(m.supportUrl)
  if (supportUrl) {
    const safe = sanitizeUrl(supportUrl.value)
    if (safe) match.supportUrl = { ...supportUrl, value: safe }
  }

  for (const p of Array.isArray(m.plans) ? m.plans : []) {
    const plan = asPlanTier(p)
    if (!plan) continue
    match.plans.push(plan)
    if (match.plans.length >= MAX_PLANS) break
  }

  for (const b of Array.isArray(m.benefits) ? m.benefits : []) {
    if (match.benefits.length >= MAX_BENEFITS) break
    if (!b || typeof b !== 'object') continue
    const bo = b as Record<string, unknown>
    const text = asTrimmed(bo.text, MAX_FACT)
    if (!text) continue
    match.benefits.push({
      text,
      sourceUrl: sanitizeUrl(bo.sourceUrl),
      confidence: asConfidence(bo.confidence)
    })
  }

  for (const a of Array.isArray(m.alternatives) ? m.alternatives : []) {
    const alt = asAlternative(a)
    if (!alt) continue
    match.alternatives.push(alt)
    if (match.alternatives.length >= MAX_ALTERNATIVES) break
  }

  const hasAnything =
    match.pricingSummary ||
    match.annualDiscount ||
    match.cancellationSteps ||
    match.cancellationUrl ||
    match.supportUrl ||
    match.plans.length > 0 ||
    match.benefits.length > 0 ||
    match.alternatives.length > 0
  if (!hasAnything) return { outcome: 'not_found', matchConfidence }

  return { outcome, matchConfidence, match }
}

/**
 * Fallback for runs that end with prose instead of the tool call: pull the
 * first balanced {...} out of the text and run it through the same validator.
 */
export function parseSubscriptionFindingsFromText(
  text: string
): ParsedSubscriptionWebFindings | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return parseSubscriptionSubmitPayload(JSON.parse(text.slice(start, i + 1)))
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

const sameValue = (a: string | null, b: string): boolean =>
  (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

/** The current core-column value a proposal diffs against — only `cancelUrl`. */
export interface SubscriptionWebEnrichSnapshot {
  cancelUrl: string | null
}

/**
 * Turn validated findings into the reviewable proposal list. A `cancellationUrl`
 * proposal equal to the current `cancelUrl` is dropped; `sourceVerified`
 * cross-checks each citation against the harvested sources.
 */
export function buildSubscriptionProposals(
  subscription: SubscriptionWebEnrichSnapshot,
  findings: ParsedSubscriptionWebFindings,
  sources: WebSource[]
): SubscriptionWebEnrichProposal[] {
  const match = findings.match
  if (!match) return []
  const sourceKeys = new Set(sources.map((s) => urlKey(s.url)))
  const verified = (sourceUrl?: string): boolean => !!sourceUrl && sourceKeys.has(urlKey(sourceUrl))

  const out: SubscriptionWebEnrichProposal[] = []
  const push = (p: Omit<SubscriptionWebEnrichProposal, 'id' | 'sourceVerified'>): void => {
    out.push({ ...p, id: out.length, sourceVerified: verified(p.sourceUrl) })
  }

  if (match.pricingSummary)
    push({
      kind: 'pricing',
      currentValue: null,
      proposedValue: match.pricingSummary.value,
      sourceUrl: match.pricingSummary.sourceUrl,
      confidence: match.pricingSummary.confidence,
      writesToSubscription: false
    })

  if (match.annualDiscount)
    push({
      kind: 'annualSavings',
      currentValue: null,
      proposedValue: match.annualDiscount.value,
      sourceUrl: match.annualDiscount.sourceUrl,
      confidence: match.annualDiscount.confidence,
      writesToSubscription: false
    })

  for (const plan of match.plans) {
    const detail = [plan.price, plan.cadence].filter(Boolean).join(' / ')
    push({
      kind: 'planTier',
      label: plan.name,
      currentValue: null,
      proposedValue: plan.note ? `${detail} — ${plan.note}` : detail,
      sourceUrl: plan.sourceUrl,
      confidence: 'medium',
      writesToSubscription: false
    })
  }

  for (const benefit of match.benefits)
    push({
      kind: 'benefit',
      currentValue: null,
      proposedValue: benefit.text,
      sourceUrl: benefit.sourceUrl,
      confidence: benefit.confidence,
      writesToSubscription: false
    })

  if (match.cancellationSteps)
    push({
      kind: 'cancellationSteps',
      currentValue: null,
      proposedValue: match.cancellationSteps.value,
      sourceUrl: match.cancellationSteps.sourceUrl,
      confidence: match.cancellationSteps.confidence,
      writesToSubscription: false
    })

  if (match.cancellationUrl && !sameValue(subscription.cancelUrl, match.cancellationUrl.value))
    push({
      kind: 'cancellationUrl',
      currentValue: subscription.cancelUrl,
      proposedValue: match.cancellationUrl.value,
      sourceUrl: match.cancellationUrl.sourceUrl,
      confidence: match.cancellationUrl.confidence,
      writesToSubscription: true
    })

  for (const alt of match.alternatives)
    push({
      kind: 'alternative',
      label: alt.name,
      currentValue: null,
      proposedValue: alt.approxPrice ? `${alt.note} (~${alt.approxPrice})` : alt.note,
      sourceUrl: alt.sourceUrl,
      confidence: 'medium',
      writesToSubscription: false
    })

  if (match.supportUrl)
    push({
      kind: 'supportUrl',
      currentValue: null,
      proposedValue: match.supportUrl.value,
      sourceUrl: match.supportUrl.sourceUrl,
      confidence: match.supportUrl.confidence,
      writesToSubscription: false
    })

  return out
}

/** The accepted core-column patch for the apply step — only `cancelUrl`. */
export function collectAcceptedSubscriptionFields(
  proposals: SubscriptionWebEnrichProposal[],
  acceptedIds: Set<number>
): Partial<Record<'cancelUrl', string>> {
  const fields: Partial<Record<'cancelUrl', string>> = {}
  for (const p of proposals) {
    if (!p.writesToSubscription || !acceptedIds.has(p.id)) continue
    if (p.kind === 'cancellationUrl') fields.cancelUrl = p.proposedValue
  }
  return fields
}

/**
 * Build the persisted `web` namespace from the ACCEPTED proposals. Sources are
 * always kept in full — they are the citation ground truth, not user data to
 * cherry-pick. A re-run replaces the whole namespace, so rejected leftovers
 * never linger.
 */
export function assembleSubscriptionWebEnrichment(
  proposals: SubscriptionWebEnrichProposal[],
  acceptedIds: Set<number>,
  meta: {
    searchedAs: string
    matchConfidence: WebConfidence
    sources: WebSource[]
    refreshedAt: number
    model?: string
  }
): SubscriptionWebEnrichment {
  let pricingSummary: string | null = null
  let annualDiscount: string | null = null
  const plans: SubscriptionWebEnrichment['plans'] = []
  const benefits: WebFact[] = []
  let cancellationSteps: string | null = null
  let cancellationUrl: string | null = null
  const alternatives: SubscriptionWebEnrichment['alternatives'] = []
  let supportUrl: string | null = null

  for (const p of proposals) {
    if (!acceptedIds.has(p.id)) continue
    if (p.kind === 'pricing') pricingSummary = p.proposedValue
    else if (p.kind === 'annualSavings') annualDiscount = p.proposedValue
    else if (p.kind === 'planTier')
      plans.push({ name: p.label ?? 'Plan', detail: p.proposedValue, sourceUrl: p.sourceUrl })
    else if (p.kind === 'benefit')
      benefits.push({ text: p.proposedValue, sourceUrl: p.sourceUrl, confidence: p.confidence })
    else if (p.kind === 'cancellationSteps') cancellationSteps = p.proposedValue
    else if (p.kind === 'cancellationUrl') cancellationUrl = p.proposedValue
    else if (p.kind === 'alternative')
      alternatives.push({
        name: p.label ?? 'Alternative',
        note: p.proposedValue,
        sourceUrl: p.sourceUrl
      })
    else if (p.kind === 'supportUrl') supportUrl = p.proposedValue
  }

  return {
    searchedAs: meta.searchedAs,
    matchConfidence: meta.matchConfidence,
    pricingSummary,
    annualDiscount,
    plans,
    benefits,
    cancellationSteps,
    cancellationUrl,
    alternatives,
    supportUrl,
    sources: meta.sources,
    refreshedAt: meta.refreshedAt,
    model: meta.model
  }
}
