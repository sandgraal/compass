/**
 * Place WEB enrichment IPC — "Enrich from web" for tracked places AND tracked
 * merchants (both live in the shared `places` table; this surface is
 * deliberately not kind-filtered). The place-flavored sibling of
 * contact-web-enrich.ts (PR #395), same flow and guardrails:
 *
 *   `places:web-enrich`        → run Anthropic's SERVER-SIDE web_search over
 *                                the place's name/category/address (+ user
 *                                hints), return reviewable proposals.
 *                                WRITES NOTHING.
 *   `places:web-enrich-apply`  → apply the proposals the user accepted, BY ID,
 *                                against the run cached here in main-process
 *                                memory — the renderer can never inject field
 *                                values or enrichment content over IPC.
 *   `places:web-enrich-cancel` → abort the in-flight run / discard the cache.
 *
 * Privacy posture: requires the user's own Anthropic key (BYO, same vault as
 * Ask Compass), fires only on an explicit button press behind a consent
 * dialog that shows the exact outbound payload (name, category, known
 * address — never notes, never visit history).
 *
 * Cost/runaway guardrails: web_search max_uses=5, maxTokens 2048, ≤3
 * `pause_turn` continuations, hard 90s abort, single in-flight run.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { places } from '../db/schema'
import { readKeyInternal } from '../integrations/assistant-vault'
import {
  type AnthropicContentBlock,
  LlmAbortError,
  type LlmMessage,
  callLlm
} from '../integrations/llm-client'
import type { WebSource } from '../lib/contact-enrichment'
import {
  PLACE_WEB_ENRICH_SYSTEM_PROMPT,
  type ParsedPlaceWebFindings,
  type PlaceWebEnrichProposal,
  SUBMIT_PLACE_FINDINGS_TOOL,
  SUBMIT_PLACE_FINDINGS_TOOL_NAME,
  WEB_SEARCH_TOOL,
  type WebCandidate,
  type WebConfidence,
  assemblePlaceWebEnrichment,
  buildPlaceProposals,
  buildPlaceSearchedAs,
  buildPlaceWebEnrichUserMessage,
  collectAcceptedPlaceFields,
  harvestSources,
  parsePlaceFindingsFromText,
  parsePlaceSubmitPayload
} from '../lib/place-web-enrichment'
import { applyPlaceWebEnrichment } from './places'

const MAX_HINTS_CHARS = 500
const MAX_CANDIDATE_HINT_CHARS = 300
const MAX_ACCEPTED_IDS = 256
const MAX_PAUSE_CONTINUATIONS = 3
const RUN_TIMEOUT_MS = 90_000
/** A stale run can't be applied — the place may have changed underneath it. */
const PENDING_RUN_TTL_MS = 30 * 60 * 1000

export interface PlaceWebEnrichRunUsage {
  searchCount: number
  inputTokens: number
  outputTokens: number
}

export type PlaceWebEnrichRunResult =
  | { success: false; error: string; needsKey?: boolean; cancelled?: boolean }
  | ({
      success: true
      outcome: 'none'
      searchedAs: string
      message: string
    } & PlaceWebEnrichRunUsage)
  | ({
      success: true
      outcome: 'candidates'
      searchedAs: string
      candidates: WebCandidate[]
    } & PlaceWebEnrichRunUsage)
  | ({
      success: true
      outcome: 'proposals'
      runId: string
      searchedAs: string
      matchConfidence: WebConfidence
      proposals: PlaceWebEnrichProposal[]
    } & PlaceWebEnrichRunUsage)

interface PendingRun {
  runId: string
  placeId: number
  proposals: PlaceWebEnrichProposal[]
  matchConfidence: WebConfidence
  sources: WebSource[]
  searchedAs: string
  model?: string
  createdAt: number
}

// Single-flight: a new run aborts the previous one (same pattern as assistant.ts).
let currentController: AbortController | null = null
// Single slot: the review dialog holds at most one un-applied run at a time.
let pendingRun: PendingRun | null = null

async function runPlaceWebEnrich(
  placeId: number,
  hints: string | undefined,
  candidateHint: string | undefined
): Promise<PlaceWebEnrichRunResult> {
  const db = getDb()
  const row = db
    .select({
      id: places.id,
      name: places.name,
      kind: places.kind,
      category: places.category,
      address: places.address,
      url: places.url
    })
    .from(places)
    .where(eq(places.id, placeId))
    .all()[0]
  if (!row) return { success: false, error: 'Place not found' }

  // Provider-pinned on purpose: web_search is an Anthropic server tool, so an
  // OpenAI-active user with an Anthropic key on file can still use this.
  const auth = readKeyInternal('anthropic')
  if (!auth) {
    return {
      success: false,
      needsKey: true,
      error: 'Web enrichment needs an Anthropic API key. Add one in Settings → AI assist.'
    }
  }

  if (currentController) currentController.abort()
  const controller = new AbortController()
  currentController = controller
  const timeoutId = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)

  const input = {
    name: row.name,
    category: row.category,
    address: row.address,
    kind: row.kind,
    hints,
    candidateHint
  }
  const searchedAs = buildPlaceSearchedAs(input)
  const messages: LlmMessage[] = [{ role: 'user', content: buildPlaceWebEnrichUserMessage(input) }]

  const usage: PlaceWebEnrichRunUsage = { searchCount: 0, inputTokens: 0, outputTokens: 0 }
  const allBlocks: AnthropicContentBlock[] = []
  let findings: ParsedPlaceWebFindings | null = null
  let model: string | undefined

  try {
    for (let pass = 0; pass <= MAX_PAUSE_CONTINUATIONS; pass++) {
      const res = await callLlm({
        provider: 'anthropic',
        apiKey: auth.key,
        model: auth.model,
        system: PLACE_WEB_ENRICH_SYSTEM_PROMPT,
        messages,
        tools: [WEB_SEARCH_TOOL, SUBMIT_PLACE_FINDINGS_TOOL],
        cacheSystem: true,
        maxTokens: 2048,
        signal: controller.signal
      })
      model = res.model
      usage.inputTokens += res.inputTokens ?? 0
      usage.outputTokens += res.outputTokens ?? 0
      for (const block of res.rawContent ?? []) {
        allBlocks.push(block)
        if (block.type === 'server_tool_use') usage.searchCount++
      }

      // Server-side search loop hit its internal limit mid-turn: resend the
      // conversation with the assistant turn echoed VERBATIM to resume.
      if (res.stopReason === 'pause_turn' && res.rawContent) {
        messages.push({ role: 'assistant', content: res.rawContent })
        continue
      }

      const submit = res.toolUses?.find((tu) => tu.name === SUBMIT_PLACE_FINDINGS_TOOL_NAME)
      if (submit) {
        findings = parsePlaceSubmitPayload(submit.input)
      } else if (res.text) {
        // Model answered in prose despite the contract — salvage defensively.
        findings = parsePlaceFindingsFromText(res.text)
      }
      break
    }
  } catch (err) {
    if (err instanceof LlmAbortError) {
      return { success: false, cancelled: true, error: 'Search cancelled' }
    }
    let message = (err as Error).message
    if (/Anthropic 4\d\d/.test(message)) {
      message +=
        ' — if this persists, check that the Anthropic model in Settings → AI assist supports web search.'
    }
    return { success: false, error: message }
  } finally {
    clearTimeout(timeoutId)
    if (currentController === controller) currentController = null
  }

  if (!findings) {
    return {
      success: true,
      outcome: 'none',
      searchedAs,
      message: 'The search finished but returned unusable output. Try again, or add a hint.',
      ...usage
    }
  }
  if (findings.outcome === 'not_found') {
    return {
      success: true,
      outcome: 'none',
      searchedAs,
      message: `No credible public presence found for "${searchedAs}".`,
      ...usage
    }
  }
  if (findings.outcome === 'ambiguous') {
    return {
      success: true,
      outcome: 'candidates',
      searchedAs,
      candidates: findings.candidates ?? [],
      ...usage
    }
  }

  const sources = harvestSources(allBlocks)
  const proposals = buildPlaceProposals(
    { category: row.category, address: row.address, url: row.url },
    findings,
    sources
  )
  if (proposals.length === 0) {
    return {
      success: true,
      outcome: 'none',
      searchedAs,
      message: 'The web had nothing beyond what this place already has.',
      ...usage
    }
  }

  pendingRun = {
    runId: randomUUID(),
    placeId,
    proposals,
    matchConfidence: findings.matchConfidence,
    sources,
    searchedAs,
    model,
    createdAt: Date.now()
  }
  return {
    success: true,
    outcome: 'proposals',
    runId: pendingRun.runId,
    searchedAs,
    matchConfidence: findings.matchConfidence,
    proposals,
    ...usage
  }
}

function applyPendingRun(
  runId: string,
  accepted: number[]
): { success: boolean; applied?: { fields: string[]; findings: number }; error?: string } {
  const run = pendingRun
  if (!run || run.runId !== runId) {
    return { success: false, error: 'This enrichment run has expired — run the search again.' }
  }
  if (Date.now() - run.createdAt > PENDING_RUN_TTL_MS) {
    pendingRun = null
    return { success: false, error: 'This enrichment run has expired — run the search again.' }
  }
  // Only ids that actually name one of THIS run's proposals count as an
  // acceptance — an empty/bogus `accepted` array must never persist a write,
  // per the "nothing is saved without review" consent model. Discard the run
  // either way so a stale runId can't be replayed with a real acceptance later.
  const validIds = new Set(run.proposals.map((p) => p.id))
  const acceptedIds = new Set(accepted.filter((id) => validIds.has(id)))
  if (acceptedIds.size === 0) {
    pendingRun = null
    return { success: true, applied: { fields: [], findings: 0 } }
  }
  const fields = collectAcceptedPlaceFields(run.proposals, acceptedIds)
  const web = assemblePlaceWebEnrichment(run.proposals, acceptedIds, {
    searchedAs: run.searchedAs,
    matchConfidence: run.matchConfidence,
    sources: run.sources,
    refreshedAt: Date.now(),
    model: run.model
  })
  const ok = applyPlaceWebEnrichment(run.placeId, fields, web)
  if (!ok) return { success: false, error: 'Place no longer exists' }
  pendingRun = null
  const findingsCount = run.proposals.filter(
    (p) => acceptedIds.has(p.id) && !p.writesToPlace
  ).length
  return { success: true, applied: { fields: Object.keys(fields), findings: findingsCount } }
}

export function registerPlaceWebEnrichHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('places:web-enrich', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { placeId, hints, candidateHint } = payload as {
      placeId?: unknown
      hints?: unknown
      candidateHint?: unknown
    }
    if (typeof placeId !== 'number' || !Number.isInteger(placeId)) {
      return { success: false, error: 'placeId must be an integer' }
    }
    const cleanHints =
      typeof hints === 'string' && hints.trim() ? hints.trim().slice(0, MAX_HINTS_CHARS) : undefined
    const cleanCandidate =
      typeof candidateHint === 'string' && candidateHint.trim()
        ? candidateHint.trim().slice(0, MAX_CANDIDATE_HINT_CHARS)
        : undefined
    return runPlaceWebEnrich(placeId, cleanHints, cleanCandidate)
  })

  ipcMain.handle('places:web-enrich-apply', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { runId, accepted } = payload as { runId?: unknown; accepted?: unknown }
    if (typeof runId !== 'string' || runId.length === 0) {
      return { success: false, error: 'runId is required' }
    }
    const acceptedIds = Array.isArray(accepted)
      ? accepted
          // Renderer-controlled input — cap before any per-item work so a huge
          // array can't burn main-process time (proposals are ≤ ~40 anyway).
          .slice(0, MAX_ACCEPTED_IDS)
          .filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      : []
    return applyPendingRun(runId, acceptedIds)
  })

  // Cancel doubles as "discard": abort any in-flight search AND invalidate the
  // cached run, so closing the review dialog leaves nothing applyable behind.
  // Always succeeds — there is nothing meaningful to report when idle.
  ipcMain.handle('places:web-enrich-cancel', () => {
    if (currentController) {
      currentController.abort()
      currentController = null
    }
    pendingRun = null
    return { success: true }
  })
}
