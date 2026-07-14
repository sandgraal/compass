/**
 * Contact WEB enrichment — the pure core of "Enrich from web".
 *
 * This is the one place in Compass that deliberately looks a person up on the
 * public web, and it only ever runs when the user presses the button and
 * confirms the consent dialog. The search itself is Anthropic's SERVER-SIDE
 * `web_search` tool (BYO key): the API runs the searches, we never fetch
 * third-party pages ourselves.
 *
 * Trust model: everything the model returns is UNTRUSTED until the user
 * reviews it. This module therefore does three defensive jobs:
 *   1. Force structured output — the model must finish by calling the
 *      `submit_web_findings` client tool (parsed input, no prose scraping).
 *   2. Validate hard — `parseSubmitPayload` clamps lengths, drops non-http(s)
 *      URLs, demotes malformed field values to plain facts.
 *   3. Verify citations — `sourceUrl`s are cross-checked against the URLs the
 *      search ACTUALLY returned (`harvestSources`), so a hallucinated citation
 *      shows up as "unverified" in the review UI.
 *
 * PURE — no Electron, no Drizzle, type-only imports — so it unit-tests
 * against fixtures like its sibling `contact-enrichment.ts`.
 */

import type {
  AnthropicContentBlock,
  AnthropicServerTool,
  AnthropicTool
} from '../integrations/llm-client'
import type { WebEnrichment, WebFact, WebLink, WebSource } from './contact-enrichment'

export type WebConfidence = 'high' | 'medium' | 'low'

/** What the orchestrator sends about the person (and nothing else). */
export interface WebEnrichInput {
  displayName: string
  org?: string | null
  jobTitle?: string | null
  /** Free-text disambiguation the user typed into the consent dialog. */
  hints?: string
  /** The candidate descriptor the user picked after an 'ambiguous' round. */
  candidateHint?: string
}

/** A scalar finding with its citation. */
export interface SourcedValue {
  value: string
  sourceUrl?: string
  confidence: WebConfidence
}

export interface WebCandidate {
  name: string
  descriptor: string
  sourceUrl?: string
}

/** The validated output of `submit_web_findings`. */
export interface ParsedWebFindings {
  outcome: 'found' | 'ambiguous' | 'not_found'
  matchConfidence: WebConfidence
  match?: {
    jobTitle?: SourcedValue
    org?: SourcedValue
    birthday?: SourcedValue
    url?: SourcedValue
    location?: SourcedValue
    bio?: SourcedValue
    links: WebLink[]
    facts: WebFact[]
  }
  candidates?: WebCandidate[]
}

/** One reviewable proposal shown in the dialog. Ids index into the run's list. */
export interface WebEnrichProposal {
  id: number
  kind: 'jobTitle' | 'org' | 'birthday' | 'url' | 'location' | 'bio' | 'link' | 'fact'
  /** Display label — the link type for `kind: 'link'`. */
  label?: string
  /** The contact's current value at run time (core fields only). */
  currentValue: string | null
  proposedValue: string
  sourceUrl?: string
  /** True when sourceUrl matches a URL the search actually returned. */
  sourceVerified: boolean
  confidence: WebConfidence
  /** True only for jobTitle | org | birthday | url — the core-column writes. */
  writesToContact: boolean
}

// ---------------------------------------------------------------------------
// Prompt + tools
// ---------------------------------------------------------------------------

/** Server-side web search. `max_uses` is the per-run cost ceiling (~1¢/search). */
export const WEB_SEARCH_TOOL: AnthropicServerTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5
}

export const SUBMIT_FINDINGS_TOOL_NAME = 'submit_web_findings'

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
 * The forced final call. We never send a tool_result back — the run ends when
 * the model calls this. Parsed tool input is far more reliable than asking a
 * small model for JSON-only prose after several search turns.
 */
export const SUBMIT_FINDINGS_TOOL: AnthropicTool = {
  name: SUBMIT_FINDINGS_TOOL_NAME,
  description:
    'Submit your final findings about the person. Call exactly once, when done searching. ' +
    'Use outcome "found" with a match, "ambiguous" with candidates when multiple plausible ' +
    'people match, or "not_found".',
  input_schema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['found', 'ambiguous', 'not_found'] },
      matchConfidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are that every finding is about the SAME, correct person'
      },
      match: {
        type: 'object',
        description: 'Only for outcome "found".',
        properties: {
          jobTitle: SOURCED_VALUE_SCHEMA,
          org: { ...SOURCED_VALUE_SCHEMA, description: 'Current employer/organization' },
          birthday: {
            ...SOURCED_VALUE_SCHEMA,
            description: 'Only if publicly stated. value MUST be YYYY-MM-DD.'
          },
          url: { ...SOURCED_VALUE_SCHEMA, description: 'Personal website / primary homepage' },
          location: { ...SOURCED_VALUE_SCHEMA, description: 'Public location, city level' },
          bio: { ...SOURCED_VALUE_SCHEMA, description: '2-4 sentence professional summary' },
          links: {
            type: 'array',
            description: 'Public profiles: LinkedIn, GitHub, X, personal site, …',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description: 'linkedin | github | x | website | other short label'
                },
                value: { type: 'string', description: 'The profile URL' },
                sourceUrl: { type: 'string' }
              },
              required: ['value']
            }
          },
          facts: {
            type: 'array',
            description: 'Notable public facts: talks, publications, awards, projects, press',
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
        description: 'Only for outcome "ambiguous": 2-5 distinct plausible people.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            descriptor: {
              type: 'string',
              description:
                'One line that tells them apart, e.g. "VP Engineering at Acme, Austin TX"'
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

export const WEB_ENRICH_SYSTEM_PROMPT = `You are a careful people-researcher inside Compass, a private personal-CRM app. Your job: find the PUBLIC web presence of ONE SPECIFIC person the user already knows, using the web_search tool, then report structured findings.

Identity rules:
- The target person is described in the user message. Search for that person specifically, refining queries with the provided organization, title, and hints.
- If results contain multiple plausible people and the hints cannot distinguish them, you MUST use outcome "ambiguous" with 2-5 candidates, each with a one-line descriptor that tells them apart. NEVER guess, and never blend details from different people.
- If you find no credible public presence, use outcome "not_found".

Evidence rules:
- Report only claims that appear in pages returned by your searches, and put the URL of the page that states each claim in its sourceUrl.
- Do not infer, extrapolate, or fill gaps from general knowledge.
- confidence: "high" = stated clearly on an authoritative page about this person; "medium" = likely but only one weak source; "low" = uncertain.

Scope rules — public, professional information only:
- In scope: current role and employer, professional bio, public profiles (LinkedIn, GitHub, X, personal site), published work, talks, awards, public city-level location, publicly celebrated birthday.
- Out of scope, never report: health, political or religious views, family members, home addresses, phone numbers, email addresses, and anything from data-broker / people-search sites (Whitepages, Spokeo, BeenVerified, etc.).

Output contract:
- When you are done searching, call ${SUBMIT_FINDINGS_TOOL_NAME} EXACTLY ONCE with your findings. Do not write a prose answer. Keep bio to 2-4 sentences.`

/** The canonical identity string — persisted as `searchedAs` so the user can always see what was searched. */
export function buildSearchedAs(input: WebEnrichInput): string {
  const paren = [input.jobTitle, input.org].filter((s): s is string => !!s?.trim()).join(', ')
  let out = input.displayName.trim()
  if (paren) out += ` (${paren})`
  if (input.hints?.trim()) out += ` — ${input.hints.trim()}`
  if (input.candidateHint?.trim()) out += ` — confirmed: ${input.candidateHint.trim()}`
  return out
}

export function buildWebEnrichUserMessage(input: WebEnrichInput): string {
  const lines = [
    'Find the public web presence of this person:',
    '',
    `Name: ${input.displayName.trim()}`
  ]
  if (input.org?.trim()) lines.push(`Organization: ${input.org.trim()}`)
  if (input.jobTitle?.trim()) lines.push(`Job title: ${input.jobTitle.trim()}`)
  if (input.hints?.trim()) lines.push(`Extra context from the user: ${input.hints.trim()}`)
  if (input.candidateHint?.trim())
    lines.push(`The user confirmed the target is: ${input.candidateHint.trim()}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Defensive validation
// ---------------------------------------------------------------------------

const MAX_VALUE = 2000
const MAX_BIO = 4000
const MAX_FACT = 1000
const MAX_LINKS = 15
const MAX_FACTS = 20
const MAX_CANDIDATES = 5
const BIRTHDAY_RE = /^\d{4}-\d{2}-\d{2}$/

function asTrimmed(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function asConfidence(v: unknown): WebConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium'
}

/**
 * Keep only URLs a browser can safely open. `javascript:`/`data:` and friends
 * must never survive to an href (same rationale as `safeHref` in Contacts.tsx).
 * A bare domain ("github.com/jane") is normalized to https.
 */
export function sanitizeUrl(v: unknown): string | undefined {
  const t = asTrimmed(v, MAX_VALUE)
  if (!t) return undefined
  if (/^https?:\/\//i.test(t)) return t
  if (/^[a-z0-9][\w.-]*\.[a-z]{2,}([/?#].*)?$/i.test(t)) return `https://${t}`
  return undefined
}

function asSourcedValue(v: unknown, max = MAX_VALUE): SourcedValue | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const value = asTrimmed(o.value, max)
  if (!value) return undefined
  return { value, sourceUrl: sanitizeUrl(o.sourceUrl), confidence: asConfidence(o.confidence) }
}

/**
 * Validate the raw `submit_web_findings` input. Returns null when the payload
 * is structurally unusable; otherwise a fully-clamped `ParsedWebFindings`
 * (individual bad items are dropped, not fatal).
 */
export function parseSubmitPayload(input: unknown): ParsedWebFindings | null {
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
  const match: NonNullable<ParsedWebFindings['match']> = { links: [], facts: [] }

  match.jobTitle = asSourcedValue(m.jobTitle)
  match.org = asSourcedValue(m.org)
  match.location = asSourcedValue(m.location)
  match.bio = asSourcedValue(m.bio, MAX_BIO)

  // Birthday must be a real ISO date; anything else survives only as a fact.
  const birthday = asSourcedValue(m.birthday, 64)
  if (birthday && BIRTHDAY_RE.test(birthday.value)) match.birthday = birthday
  else if (birthday)
    match.facts.push({
      text: `Birthday (unparsed): ${birthday.value}`,
      sourceUrl: birthday.sourceUrl,
      confidence: birthday.confidence
    })

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
    match.jobTitle ||
    match.org ||
    match.birthday ||
    match.url ||
    match.location ||
    match.bio ||
    match.links.length > 0 ||
    match.facts.length > 0
  if (!hasAnything) return { outcome: 'not_found', matchConfidence }

  return { outcome, matchConfidence, match }
}

/**
 * Fallback for runs that end with prose instead of the tool call: pull the
 * first balanced {...} out of the text and run it through the same validator.
 */
export function parseFindingsFromText(text: string): ParsedWebFindings | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return parseSubmitPayload(JSON.parse(text.slice(start, i + 1)))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Sources + proposals
// ---------------------------------------------------------------------------

const MAX_SOURCES = 25

/** Normalize for citation matching only (never for display/storage). */
function urlKey(u: string): string {
  return u.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '')
}

/**
 * Collect the pages the search ACTUALLY returned — the ground truth that
 * `sourceUrl` citations verify against. Failed searches come back with an
 * object-shaped `content` (`{error_code}`), which we skip.
 */
export function harvestSources(rawContent: AnthropicContentBlock[] | undefined): WebSource[] {
  const out: WebSource[] = []
  const seen = new Set<string>()
  for (const block of rawContent ?? []) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const item of block.content as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object' || item.type !== 'web_search_result') continue
      const url = sanitizeUrl(item.url)
      if (!url) continue
      const key = urlKey(url)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ url, title: asTrimmed(item.title, 300) ?? undefined })
      if (out.length >= MAX_SOURCES) return out
    }
  }
  return out
}

/** The current core-column values a proposal diffs against. */
export interface WebEnrichContactSnapshot {
  jobTitle: string | null
  org: string | null
  birthday: string | null
  url: string | null
}

const sameValue = (a: string | null, b: string): boolean =>
  (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Turn validated findings into the reviewable proposal list. Proposals equal
 * to the current value are dropped; `sourceVerified` cross-checks each
 * citation against the harvested sources.
 */
export function buildProposals(
  contact: WebEnrichContactSnapshot,
  findings: ParsedWebFindings,
  sources: WebSource[]
): WebEnrichProposal[] {
  const match = findings.match
  if (!match) return []
  const sourceKeys = new Set(sources.map((s) => urlKey(s.url)))
  const verified = (sourceUrl?: string): boolean => !!sourceUrl && sourceKeys.has(urlKey(sourceUrl))

  const out: WebEnrichProposal[] = []
  const push = (p: Omit<WebEnrichProposal, 'id' | 'sourceVerified'>): void => {
    out.push({ ...p, id: out.length, sourceVerified: verified(p.sourceUrl) })
  }

  const core: Array<['jobTitle' | 'org' | 'birthday' | 'url', SourcedValue | undefined]> = [
    ['jobTitle', match.jobTitle],
    ['org', match.org],
    ['birthday', match.birthday],
    ['url', match.url]
  ]
  for (const [kind, sv] of core) {
    if (!sv || sameValue(contact[kind], sv.value)) continue
    push({
      kind,
      currentValue: contact[kind],
      proposedValue: sv.value,
      sourceUrl: sv.sourceUrl,
      confidence: sv.confidence,
      writesToContact: true
    })
  }

  if (match.location)
    push({
      kind: 'location',
      currentValue: null,
      proposedValue: match.location.value,
      sourceUrl: match.location.sourceUrl,
      confidence: match.location.confidence,
      writesToContact: false
    })
  if (match.bio)
    push({
      kind: 'bio',
      currentValue: null,
      proposedValue: match.bio.value,
      sourceUrl: match.bio.sourceUrl,
      confidence: match.bio.confidence,
      writesToContact: false
    })
  for (const link of match.links)
    push({
      kind: 'link',
      label: link.type,
      currentValue: null,
      proposedValue: link.value,
      sourceUrl: link.sourceUrl,
      confidence: 'medium',
      writesToContact: false
    })
  for (const fact of match.facts)
    push({
      kind: 'fact',
      currentValue: null,
      proposedValue: fact.text,
      sourceUrl: fact.sourceUrl,
      confidence: fact.confidence,
      writesToContact: false
    })
  return out
}

/** The accepted core-column patch for `applyWebEnrichment`. */
export function collectAcceptedFields(
  proposals: WebEnrichProposal[],
  acceptedIds: Set<number>
): Partial<Record<'jobTitle' | 'org' | 'birthday' | 'url', string>> {
  const fields: Partial<Record<'jobTitle' | 'org' | 'birthday' | 'url', string>> = {}
  for (const p of proposals) {
    if (!p.writesToContact || !acceptedIds.has(p.id)) continue
    if (p.kind === 'jobTitle' || p.kind === 'org' || p.kind === 'birthday' || p.kind === 'url')
      fields[p.kind] = p.proposedValue
  }
  return fields
}

/**
 * Build the persisted `web` namespace from the ACCEPTED proposals. Sources are
 * always kept in full — they are the citation ground truth, not user data to
 * cherry-pick. A re-run replaces the whole namespace (mergeEnrichment
 * semantics), so rejected leftovers never linger.
 */
export function assembleWebEnrichment(
  proposals: WebEnrichProposal[],
  acceptedIds: Set<number>,
  meta: {
    searchedAs: string
    matchConfidence: WebConfidence
    sources: WebSource[]
    refreshedAt: number
    model?: string
  }
): WebEnrichment {
  const links: WebLink[] = []
  const facts: WebFact[] = []
  let bio: string | null = null
  let location: string | null = null
  for (const p of proposals) {
    if (!acceptedIds.has(p.id)) continue
    if (p.kind === 'link')
      links.push({ type: p.label, value: p.proposedValue, sourceUrl: p.sourceUrl })
    else if (p.kind === 'fact')
      facts.push({ text: p.proposedValue, sourceUrl: p.sourceUrl, confidence: p.confidence })
    else if (p.kind === 'bio') bio = p.proposedValue
    else if (p.kind === 'location') location = p.proposedValue
  }
  return {
    searchedAs: meta.searchedAs,
    matchConfidence: meta.matchConfidence,
    bio,
    location,
    links,
    facts,
    sources: meta.sources,
    refreshedAt: meta.refreshedAt,
    model: meta.model
  }
}
