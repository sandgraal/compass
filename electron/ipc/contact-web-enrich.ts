/**
 * Contact WEB enrichment IPC — the explicit-opt-in counterpart to the
 * local-only orchestrator in `contact-enrich.ts`.
 *
 * Flow (all user-driven, per contact, from the consent dialog):
 *   `contacts:web-enrich`        → run Anthropic's SERVER-SIDE web_search over
 *                                  the contact's name/org/title (+ user hints),
 *                                  return reviewable proposals. WRITES NOTHING.
 *   `contacts:web-enrich-apply`  → apply the proposals the user accepted, BY ID,
 *                                  against the run cached here in main-process
 *                                  memory — the renderer can never inject field
 *                                  values or enrichment content over IPC.
 *   `contacts:web-enrich-cancel` → abort the in-flight run.
 *
 * Privacy posture: this is the ONE place Compass looks a person up on the
 * public web. It requires the user's own Anthropic key (BYO, same vault as
 * Ask Compass), fires only on an explicit button press behind a consent dialog
 * that shows the exact outbound payload, and never sends emails/phones — nor
 * writes them, since a wrong identifier could trigger contact auto-merge.
 *
 * Cost/runaway guardrails: web_search max_uses=5, maxTokens 2048, ≤3
 * `pause_turn` continuations, hard 90s abort, single in-flight run.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { IpcMain } from 'electron'
import { getDb } from '../db/client'
import { contacts } from '../db/schema'
import { readKeyInternal } from '../integrations/assistant-vault'
import {
  type AnthropicContentBlock,
  LlmAbortError,
  type LlmMessage,
  callLlm
} from '../integrations/llm-client'
import type { WebSource } from '../lib/contact-enrichment'
import {
  type ParsedWebFindings,
  SUBMIT_FINDINGS_TOOL,
  SUBMIT_FINDINGS_TOOL_NAME,
  WEB_ENRICH_SYSTEM_PROMPT,
  WEB_SEARCH_TOOL,
  type WebCandidate,
  type WebConfidence,
  type WebEnrichProposal,
  assembleWebEnrichment,
  buildProposals,
  buildSearchedAs,
  buildWebEnrichUserMessage,
  collectAcceptedFields,
  harvestSources,
  parseFindingsFromText,
  parseSubmitPayload
} from '../lib/contact-web-enrichment'
import { applyWebEnrichment, syncRelationships } from './contacts'

const MAX_HINTS_CHARS = 500
const MAX_CANDIDATE_HINT_CHARS = 300
const MAX_PAUSE_CONTINUATIONS = 3
const RUN_TIMEOUT_MS = 90_000
/** A stale run can't be applied — the contact may have changed underneath it. */
const PENDING_RUN_TTL_MS = 30 * 60 * 1000

export interface WebEnrichRunUsage {
  searchCount: number
  inputTokens: number
  outputTokens: number
}

export type WebEnrichRunResult =
  | { success: false; error: string; needsKey?: boolean; cancelled?: boolean }
  | ({ success: true; outcome: 'none'; searchedAs: string; message: string } & WebEnrichRunUsage)
  | ({
      success: true
      outcome: 'candidates'
      searchedAs: string
      candidates: WebCandidate[]
    } & WebEnrichRunUsage)
  | ({
      success: true
      outcome: 'proposals'
      runId: string
      searchedAs: string
      matchConfidence: WebConfidence
      proposals: WebEnrichProposal[]
    } & WebEnrichRunUsage)

interface PendingRun {
  runId: string
  contactId: number
  proposals: WebEnrichProposal[]
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

async function runWebEnrich(
  contactId: number,
  hints: string | undefined,
  candidateHint: string | undefined
): Promise<WebEnrichRunResult> {
  const db = getDb()
  const row = db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      org: contacts.org,
      jobTitle: contacts.jobTitle,
      birthday: contacts.birthday,
      url: contacts.url
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .all()[0]
  if (!row) return { success: false, error: 'Contact not found' }

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
    displayName: row.displayName,
    org: row.org,
    jobTitle: row.jobTitle,
    hints,
    candidateHint
  }
  const searchedAs = buildSearchedAs(input)
  const messages: LlmMessage[] = [{ role: 'user', content: buildWebEnrichUserMessage(input) }]

  const usage: WebEnrichRunUsage = { searchCount: 0, inputTokens: 0, outputTokens: 0 }
  const allBlocks: AnthropicContentBlock[] = []
  let findings: ParsedWebFindings | null = null
  let model: string | undefined

  try {
    for (let pass = 0; pass <= MAX_PAUSE_CONTINUATIONS; pass++) {
      const res = await callLlm({
        provider: 'anthropic',
        apiKey: auth.key,
        model: auth.model,
        system: WEB_ENRICH_SYSTEM_PROMPT,
        messages,
        tools: [WEB_SEARCH_TOOL, SUBMIT_FINDINGS_TOOL],
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

      const submit = res.toolUses?.find((tu) => tu.name === SUBMIT_FINDINGS_TOOL_NAME)
      if (submit) {
        findings = parseSubmitPayload(submit.input)
      } else if (res.text) {
        // Model answered in prose despite the contract — salvage defensively.
        findings = parseFindingsFromText(res.text)
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
  const proposals = buildProposals(
    { jobTitle: row.jobTitle, org: row.org, birthday: row.birthday, url: row.url },
    findings,
    sources
  )
  if (proposals.length === 0) {
    return {
      success: true,
      outcome: 'none',
      searchedAs,
      message: 'The web had nothing beyond what this contact already has.',
      ...usage
    }
  }

  pendingRun = {
    runId: randomUUID(),
    contactId,
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
  const fields = collectAcceptedFields(run.proposals, acceptedIds)
  const web = assembleWebEnrichment(run.proposals, acceptedIds, {
    searchedAs: run.searchedAs,
    matchConfidence: run.matchConfidence,
    sources: run.sources,
    refreshedAt: Date.now(),
    model: run.model
  })
  const ok = applyWebEnrichment(run.contactId, fields, web)
  if (!ok) return { success: false, error: 'Contact no longer exists' }
  pendingRun = null
  syncRelationships()
  const findingsCount = run.proposals.filter(
    (p) => acceptedIds.has(p.id) && !p.writesToContact
  ).length
  return { success: true, applied: { fields: Object.keys(fields), findings: findingsCount } }
}

export function registerContactWebEnrichHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('contacts:web-enrich', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { contactId, hints, candidateHint } = payload as {
      contactId?: unknown
      hints?: unknown
      candidateHint?: unknown
    }
    if (typeof contactId !== 'number' || !Number.isInteger(contactId)) {
      return { success: false, error: 'contactId must be an integer' }
    }
    const cleanHints =
      typeof hints === 'string' && hints.trim() ? hints.trim().slice(0, MAX_HINTS_CHARS) : undefined
    const cleanCandidate =
      typeof candidateHint === 'string' && candidateHint.trim()
        ? candidateHint.trim().slice(0, MAX_CANDIDATE_HINT_CHARS)
        : undefined
    return runWebEnrich(contactId, cleanHints, cleanCandidate)
  })

  ipcMain.handle('contacts:web-enrich-apply', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { runId, accepted } = payload as { runId?: unknown; accepted?: unknown }
    if (typeof runId !== 'string' || runId.length === 0) {
      return { success: false, error: 'runId is required' }
    }
    const acceptedIds = Array.isArray(accepted)
      ? accepted.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      : []
    return applyPendingRun(runId, acceptedIds)
  })

  ipcMain.handle('contacts:web-enrich-cancel', () => {
    if (currentController) {
      currentController.abort()
      currentController = null
      return { success: true }
    }
    return { success: false, error: 'No in-flight web enrichment' }
  })
}
