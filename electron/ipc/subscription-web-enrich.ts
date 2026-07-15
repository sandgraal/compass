/**
 * Subscription WEB enrichment IPC — "Enrich from web" for tracked
 * subscriptions. The subscription-flavored sibling of place-web-enrich.ts
 * (itself a sibling of contact-web-enrich.ts, PR #395), same flow and
 * guardrails:
 *
 *   `subscriptions:web-enrich`        → run Anthropic's SERVER-SIDE
 *                                        web_search over the subscription's
 *                                        name/category/cost/cadence (+ user
 *                                        hints), return reviewable proposals.
 *                                        WRITES NOTHING.
 *   `subscriptions:web-enrich-apply`  → apply the proposals the user
 *                                        accepted, BY ID, against the run
 *                                        cached here in main-process memory —
 *                                        the renderer can never inject field
 *                                        values or enrichment content over IPC.
 *   `subscriptions:web-enrich-cancel` → abort the in-flight run / discard the
 *                                        cache.
 *
 * Privacy posture: requires the user's own Anthropic key (BYO, same vault as
 * Ask Compass), fires only on an explicit button press behind a consent
 * dialog that shows the exact outbound payload (name, category, cost/cadence
 * — never notes, never payment account).
 *
 * Cost/runaway guardrails: web_search max_uses=5, maxTokens 2048, ≤3
 * `pause_turn` continuations, hard 90s abort, single in-flight run.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { subscriptions } from '../db/schema'
import { readKeyInternal } from '../integrations/assistant-vault'
import {
  type AnthropicContentBlock,
  LlmAbortError,
  type LlmMessage,
  callLlm
} from '../integrations/llm-client'
import type { WebSource } from '../lib/contact-enrichment'
import { matchKeyForSubscription } from '../lib/merchant-match'
import {
  type ParsedSubscriptionWebFindings,
  SUBMIT_SUBSCRIPTION_FINDINGS_TOOL,
  SUBMIT_SUBSCRIPTION_FINDINGS_TOOL_NAME,
  SUBSCRIPTION_WEB_ENRICH_SYSTEM_PROMPT,
  type SubscriptionWebEnrichProposal,
  WEB_SEARCH_TOOL,
  type WebCandidate,
  type WebConfidence,
  assembleSubscriptionWebEnrichment,
  buildSubscriptionProposals,
  buildSubscriptionSearchedAs,
  buildSubscriptionWebEnrichUserMessage,
  collectAcceptedSubscriptionFields,
  harvestSources,
  parseSubscriptionFindingsFromText,
  parseSubscriptionSubmitPayload
} from '../lib/subscription-web-enrichment'
import { applySubscriptionWebEnrichment, findLinkedMerchantUrl } from './subscriptions'

const MAX_HINTS_CHARS = 500
const MAX_CANDIDATE_HINT_CHARS = 300
const MAX_ACCEPTED_IDS = 256
const MAX_PAUSE_CONTINUATIONS = 3
const RUN_TIMEOUT_MS = 90_000
/** A stale run can't be applied — the subscription may have changed underneath it. */
const PENDING_RUN_TTL_MS = 30 * 60 * 1000

export interface SubscriptionWebEnrichRunUsage {
  searchCount: number
  inputTokens: number
  outputTokens: number
}

export type SubscriptionWebEnrichRunResult =
  | { success: false; error: string; needsKey?: boolean; cancelled?: boolean }
  | ({
      success: true
      outcome: 'none'
      searchedAs: string
      message: string
    } & SubscriptionWebEnrichRunUsage)
  | ({
      success: true
      outcome: 'candidates'
      searchedAs: string
      candidates: WebCandidate[]
    } & SubscriptionWebEnrichRunUsage)
  | ({
      success: true
      outcome: 'proposals'
      runId: string
      searchedAs: string
      matchConfidence: WebConfidence
      proposals: SubscriptionWebEnrichProposal[]
    } & SubscriptionWebEnrichRunUsage)

interface PendingRun {
  runId: string
  subscriptionId: number
  proposals: SubscriptionWebEnrichProposal[]
  matchConfidence: WebConfidence
  sources: WebSource[]
  searchedAs: string
  model?: string
  createdAt: number
}

// Single-flight: a new run aborts the previous one (same pattern as places/assistant).
let currentController: AbortController | null = null
// Single slot: the review dialog holds at most one un-applied run at a time.
let pendingRun: PendingRun | null = null

async function runSubscriptionWebEnrich(
  subscriptionId: number,
  hints: string | undefined,
  candidateHint: string | undefined,
  knownUrlHint: string | null
): Promise<SubscriptionWebEnrichRunResult> {
  const db = getDb()
  const row = db
    .select({
      id: subscriptions.id,
      name: subscriptions.name,
      category: subscriptions.category,
      cost: subscriptions.cost,
      cadence: subscriptions.cadence,
      cancelUrl: subscriptions.cancelUrl
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .all()[0]
  if (!row) return { success: false, error: 'Subscription not found' }

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
    cost: row.cost,
    cadence: row.cadence,
    knownUrlHint,
    hints,
    candidateHint
  }
  const searchedAs = buildSubscriptionSearchedAs(input)
  const messages: LlmMessage[] = [
    { role: 'user', content: buildSubscriptionWebEnrichUserMessage(input) }
  ]

  const usage: SubscriptionWebEnrichRunUsage = { searchCount: 0, inputTokens: 0, outputTokens: 0 }
  const allBlocks: AnthropicContentBlock[] = []
  let findings: ParsedSubscriptionWebFindings | null = null
  let model: string | undefined

  try {
    for (let pass = 0; pass <= MAX_PAUSE_CONTINUATIONS; pass++) {
      const res = await callLlm({
        provider: 'anthropic',
        apiKey: auth.key,
        model: auth.model,
        system: SUBSCRIPTION_WEB_ENRICH_SYSTEM_PROMPT,
        messages,
        tools: [WEB_SEARCH_TOOL, SUBMIT_SUBSCRIPTION_FINDINGS_TOOL],
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

      const submit = res.toolUses?.find((tu) => tu.name === SUBMIT_SUBSCRIPTION_FINDINGS_TOOL_NAME)
      if (submit) {
        findings = parseSubscriptionSubmitPayload(submit.input)
      } else if (res.text) {
        // Model answered in prose despite the contract — salvage defensively.
        findings = parseSubscriptionFindingsFromText(res.text)
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
  const proposals = buildSubscriptionProposals({ cancelUrl: row.cancelUrl }, findings, sources)
  if (proposals.length === 0) {
    return {
      success: true,
      outcome: 'none',
      searchedAs,
      message: 'The web had nothing beyond what this subscription already has.',
      ...usage
    }
  }

  pendingRun = {
    runId: randomUUID(),
    subscriptionId,
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
  const acceptedIds = new Set(accepted)
  const fields = collectAcceptedSubscriptionFields(run.proposals, acceptedIds)
  const web = assembleSubscriptionWebEnrichment(run.proposals, acceptedIds, {
    searchedAs: run.searchedAs,
    matchConfidence: run.matchConfidence,
    sources: run.sources,
    refreshedAt: Date.now(),
    model: run.model
  })
  const ok = applySubscriptionWebEnrichment(run.subscriptionId, fields, web)
  if (!ok) return { success: false, error: 'Subscription no longer exists' }
  pendingRun = null
  const findingsCount = run.proposals.filter(
    (p) => acceptedIds.has(p.id) && !p.writesToSubscription
  ).length
  return { success: true, applied: { fields: Object.keys(fields), findings: findingsCount } }
}

export function registerSubscriptionWebEnrichHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('subscriptions:web-enrich', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { subscriptionId, hints, candidateHint } = payload as {
      subscriptionId?: unknown
      hints?: unknown
      candidateHint?: unknown
    }
    if (typeof subscriptionId !== 'number' || !Number.isInteger(subscriptionId)) {
      return { success: false, error: 'subscriptionId must be an integer' }
    }
    const cleanHints =
      typeof hints === 'string' && hints.trim() ? hints.trim().slice(0, MAX_HINTS_CHARS) : undefined
    const cleanCandidate =
      typeof candidateHint === 'string' && candidateHint.trim()
        ? candidateHint.trim().slice(0, MAX_CANDIDATE_HINT_CHARS)
        : undefined
    const db = getDb()
    const idRow = db
      .select({ externalId: subscriptions.externalId, name: subscriptions.name })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .all()[0]
    // A hint is a nice-to-have, never worth failing the run over.
    let knownUrlHint: string | null = null
    try {
      if (idRow)
        knownUrlHint = findLinkedMerchantUrl(matchKeyForSubscription(idRow.externalId, idRow.name))
    } catch {
      /* proceed without the hint */
    }
    return runSubscriptionWebEnrich(subscriptionId, cleanHints, cleanCandidate, knownUrlHint)
  })

  ipcMain.handle('subscriptions:web-enrich-apply', (_event, payload: unknown) => {
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
  ipcMain.handle('subscriptions:web-enrich-cancel', () => {
    if (currentController) {
      currentController.abort()
      currentController = null
    }
    pendingRun = null
    return { success: true }
  })
}
