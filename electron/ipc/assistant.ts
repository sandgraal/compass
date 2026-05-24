/**
 * Ask Compass — the in-app RAG assistant (Tier 2 #7).
 *
 * Composition of two already-merged systems:
 *   - The semantic search index (`electron/knowledge/embeddings.ts`,
 *     Phase 5.9) provides on-topic context chunks.
 *   - The BYO-key LLM client (`electron/integrations/llm-client.ts`)
 *     turns the chunks + the user's question into a cited answer.
 *
 * Privacy posture:
 *   - The renderer's question + the top-K knowledge chunks are sent
 *     to the configured provider (Anthropic or OpenAI). NOTHING else
 *     leaves the machine — no vault, no DB rows, no other notes.
 *   - The API key never crosses the IPC boundary in either direction
 *     after it's set. The renderer can read a masked tail via
 *     `assistant:get-status`; the raw value is only ever read from
 *     `readActiveKeyInternal()` inside this handler.
 *   - If semantic search isn't built (or fails), we degrade to a
 *     keyword-only context pass over the knowledge index so the
 *     assistant still works without the embedding model installed.
 *
 * Cancellation: a single in-flight request is tracked via
 * `currentController`. A second `assistant:ask` while one is running
 * aborts the previous one — keeps the IPC API simple and matches the
 * UI affordance (one chat panel, one Send button).
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IpcMain } from 'electron'
import { getDb, getRawSqlite } from '../db/client'
import { ASSISTANT_TOOLS, executeAssistantTool } from '../integrations/assistant-tools'
import {
  type LlmProvider,
  clearAllAssistantKeys,
  clearAssistantKey,
  getAssistantStatus,
  readActiveKeyInternal,
  readKeyInternal,
  setActiveProvider,
  setAssistantKey,
  setProviderModel
} from '../integrations/assistant-vault'
import {
  type AnthropicContentBlock,
  LlmAbortError,
  type LlmMessage,
  callLlm
} from '../integrations/llm-client'
import { semanticSearch } from '../knowledge/embeddings'
import { KNOWLEDGE_DIR } from '../paths'

const MAX_AGENT_STEPS = 6

const AGENT_SYSTEM_PROMPT = `You are Compass, the user's local-first personal life-OS assistant, running inside the Compass app with tools over the user's own data.

You can READ the user's agenda and finances with tools, and you can PROPOSE changes — but you can NEVER write to the user's data directly.

How to work:
- Call a read tool (e.g. get_upcoming, get_finance_summary) to ground your answer in real data BEFORE answering. Don't guess at the user's tasks, events, or numbers.
- To add or change something, call a propose_* tool. This enqueues a proposal the user must APPROVE in the Compass "Claude Inbox" — it does NOT take effect immediately. After proposing, tell the user plainly that you've queued it for their approval and that nothing has changed yet. Never claim you already made the change.
- Finances are summaries only (no individual transactions). The vault (secrets) is never available to you.
- Be concise. Prefer tight bullets. When you cite a number or item, it should come from a tool result, not memory.`

const MAX_QUESTION_LENGTH = 2000
const MAX_HISTORY_TURNS = 12
const TOP_K_CONTEXT = 6
const MIN_SEMANTIC_SCORE = 0.2

let currentController: AbortController | null = null

interface ContextChunk {
  path: string
  title: string
  snippet: string
  score: number
}

/**
 * Build the (up to TOP_K_CONTEXT) chunks the LLM gets as grounding.
 * Prefers semantic search; falls back to a simple keyword scan over
 * the knowledge index when no embedding model is available.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmAbortError()
}

async function gatherContext(question: string, signal?: AbortSignal): Promise<ContextChunk[]> {
  throwIfAborted(signal)
  // Try semantic search first. semanticSearch returns null when the
  // index hasn't been built, throws when Ollama is offline.
  try {
    const hits = await semanticSearch(question, {
      limit: TOP_K_CONTEXT,
      minScore: MIN_SEMANTIC_SCORE
    })
    if (hits && hits.length > 0) {
      return hits.map((h) => ({
        path: h.path,
        title: h.title,
        snippet: h.snippet,
        score: h.score
      }))
    }
  } catch {
    /* fall through to keyword scan */
  }
  throwIfAborted(signal)

  // Keyword fallback. Cheap N-walk over markdown files; the knowledge
  // base is typically small enough that this is fine.
  const lq = question.toLowerCase()
  const tokens = lq.split(/\s+/).filter((t) => t.length > 2)
  if (tokens.length === 0) return []

  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')

  function walk(dir: string, out: string[] = []): string[] {
    throwIfAborted(signal)
    if (!existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      throwIfAborted(signal)
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
    }
    return out
  }

  const scored: ContextChunk[] = []
  for (const full of walk(KNOWLEDGE_DIR)) {
    throwIfAborted(signal)
    let content: string
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const lc = content.toLowerCase()
    let score = 0
    for (const tok of tokens) {
      const matches = lc.split(tok).length - 1
      score += matches
    }
    if (score === 0) continue
    const titleMatch = content.match(/^#\s+(.+)$/m)
    const title = titleMatch ? titleMatch[1].trim() : path.basename(full, '.md')
    const firstHit = lc.indexOf(tokens[0])
    const snippet = content
      .slice(Math.max(0, firstHit - 40), firstHit + 200)
      .replace(/\s+/g, ' ')
      .trim()
    scored.push({
      path: path.relative(KNOWLEDGE_DIR, full),
      title,
      snippet,
      score
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, TOP_K_CONTEXT)
}

const SYSTEM_PROMPT = `You are Compass, the user's local-first personal life-OS assistant.

Answer the user's question using ONLY the numbered context blocks below. Each block is a snippet from one of the user's own knowledge notes. Cite the blocks you use inline as [1], [2], etc. — matching their numbers in the context list.

Rules:
- If the context does not contain an answer, say so plainly. Do not invent facts.
- When a fact only partially answers the question, note what is missing.
- Be concise: short paragraphs and tight bullet lists. No filler preambles.
- Keep the user's own terminology and acronyms; do not "translate" them.
- Cite at least one block when you make a claim grounded in the context. Place the citation at the END of the sentence containing the fact, e.g. "Your CR property pays its electricity on the 5th [3]."

Format your reply as Markdown — headings, lists, bold, italic, inline code, links, and fenced code blocks all render properly in the chat. Use them when they help; don't dress up short answers with structure they don't need.`

function buildContextBlock(chunks: ContextChunk[]): string {
  if (chunks.length === 0) {
    return 'No numbered context blocks are available for this question. Do not answer from general knowledge. Instead, say plainly that you cannot answer from the provided context and that no citations are available.'
  }
  return chunks
    .map((c, i) => `[${i + 1}] (${c.path} — ${c.title})\n${c.snippet}`)
    .join('\n\n---\n\n')
}

/**
 * Scrub a tool-execution error before it's handed back to the model. The
 * agent's own validation messages are safe and useful, but a raw DB/library
 * error can echo SQL or user values — so collapse whitespace and cap length.
 */
function sanitizeToolError(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine
}

interface AgentResult {
  answer: string
  model: string
  toolCalls: Array<{ name: string; ok: boolean }>
  proposalIds: string[]
  inputTokens: number
  outputTokens: number
}

/**
 * Bounded Anthropic tool-use loop (Phase 8.5). The model reads via tools and
 * proposes changes via `propose_*` (which enqueue to the Claude Inbox — never a
 * direct write). Each step calls the Messages API with the tool set + prompt
 * caching; we execute any `tool_use` blocks locally and feed `tool_result`s
 * back until the model stops requesting tools (or we hit MAX_AGENT_STEPS).
 */
async function runAgent(
  auth: { provider: LlmProvider; key: string; model?: string },
  question: string,
  history: LlmMessage[],
  signal: AbortSignal
): Promise<AgentResult> {
  const db = getDb()
  const sqlite = getRawSqlite()
  const messages: LlmMessage[] = [...history, { role: 'user', content: question }]
  const toolCalls: Array<{ name: string; ok: boolean }> = []
  const proposalIds: string[] = []
  let answer = ''
  let model = auth.model ?? ''
  let inputTokens = 0
  let outputTokens = 0

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    throwIfAborted(signal)
    const res = await callLlm({
      provider: 'anthropic',
      apiKey: auth.key,
      model: auth.model,
      system: AGENT_SYSTEM_PROMPT,
      messages,
      tools: ASSISTANT_TOOLS as unknown as Parameters<typeof callLlm>[0]['tools'],
      cacheSystem: true,
      maxTokens: 1024,
      signal
    })
    model = res.model
    inputTokens += res.inputTokens ?? 0
    outputTokens += res.outputTokens ?? 0

    if (res.stopReason === 'tool_use' && res.toolUses && res.toolUses.length > 0) {
      // Record the assistant's turn (text + the tool_use blocks) verbatim.
      const assistantBlocks: AnthropicContentBlock[] = []
      if (res.text) assistantBlocks.push({ type: 'text', text: res.text })
      for (const tu of res.toolUses) {
        assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      }
      messages.push({ role: 'assistant', content: assistantBlocks })

      // Execute each requested tool and feed results back.
      const resultBlocks: AnthropicContentBlock[] = []
      for (const tu of res.toolUses) {
        const out = executeAssistantTool(db, sqlite, tu.name, tu.input)
        toolCalls.push({ name: tu.name, ok: out.ok })
        if (out.ok) {
          const data = out.data as { proposalId?: string }
          if (typeof data?.proposalId === 'string') proposalIds.push(data.proposalId)
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          // Sanitize failures before they reach the provider: raw DB/library
          // errors can carry SQL fragments or user values. Send a short, scrubbed
          // message only (full detail stays local via the toolCalls trace).
          content: JSON.stringify(out.ok ? out.data : { error: sanitizeToolError(out.error) }),
          is_error: !out.ok
        })
      }
      messages.push({ role: 'user', content: resultBlocks })
      continue
    }

    // No tool requested → this is the final answer.
    answer = res.text
    break
  }

  if (!answer) {
    answer =
      'I gathered what I could but ran out of reasoning steps before finishing. Try narrowing the request.'
  }
  return { answer, model, toolCalls, proposalIds, inputTokens, outputTokens }
}

export function registerAssistantHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('assistant:get-status', () => {
    return getAssistantStatus()
  })

  ipcMain.handle('assistant:set-key', (_event, provider: unknown, key: unknown) => {
    if (provider !== 'anthropic' && provider !== 'openai') {
      return { success: false, error: `Unknown provider: ${String(provider)}` }
    }
    if (typeof key !== 'string') {
      return { success: false, error: 'Key must be a string' }
    }
    try {
      setAssistantKey(provider as LlmProvider, key)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('assistant:clear-key', (_event, provider: unknown) => {
    try {
      if (provider === 'anthropic' || provider === 'openai') {
        clearAssistantKey(provider)
      } else {
        clearAllAssistantKeys()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('assistant:set-active-provider', (_event, provider: unknown) => {
    if (provider !== 'anthropic' && provider !== 'openai') {
      return { success: false, error: `Unknown provider: ${String(provider)}` }
    }
    try {
      setActiveProvider(provider)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('assistant:set-model', (_event, provider: unknown, model: unknown) => {
    if (provider !== 'anthropic' && provider !== 'openai') {
      return { success: false, error: `Unknown provider: ${String(provider)}` }
    }
    if (typeof model !== 'string') {
      return { success: false, error: 'Model must be a string' }
    }
    try {
      setProviderModel(provider, model)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('assistant:test-key', async (_event, provider: unknown) => {
    if (provider !== 'anthropic' && provider !== 'openai') {
      return { success: false, error: `Unknown provider: ${String(provider)}` }
    }
    const auth = readKeyInternal(provider)
    if (!auth) {
      return { success: false, error: `No ${provider} key configured.` }
    }
    // Independent AbortController so a Test never cancels an in-flight ask.
    // Hard 15s timeout so a stalled provider can't pin the Settings UI
    // in a perpetual "Testing…" state.
    const controller = new AbortController()
    const TEST_TIMEOUT_MS = 15000
    const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      await callLlm({
        provider: auth.provider,
        apiKey: auth.key,
        model: auth.model,
        system: 'Reply with the single character: ok',
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        signal: controller.signal
      })
      return { success: true }
    } catch (err) {
      if (err instanceof LlmAbortError) {
        return {
          success: false,
          error: `Test timed out after ${TEST_TIMEOUT_MS / 1000}s — check your network or the provider's status page.`
        }
      }
      return { success: false, error: (err as Error).message }
    } finally {
      clearTimeout(timeoutId)
    }
  })

  ipcMain.handle('assistant:cancel', () => {
    if (currentController) {
      currentController.abort()
      currentController = null
      return { success: true }
    }
    return { success: false, error: 'No in-flight request' }
  })

  ipcMain.handle('assistant:ask', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { question, history } = payload as {
      question?: unknown
      history?: unknown
    }
    if (typeof question !== 'string' || question.trim().length === 0) {
      return { success: false, error: 'Question is required' }
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return {
        success: false,
        error: `Question is too long (max ${MAX_QUESTION_LENGTH} characters)`
      }
    }
    const cleanedHistory: LlmMessage[] = Array.isArray(history)
      ? history
          .filter(
            (m): m is { role: 'user' | 'assistant'; content: string } =>
              !!m &&
              typeof m === 'object' &&
              'role' in m &&
              'content' in m &&
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string'
          )
          .slice(-MAX_HISTORY_TURNS * 2)
      : []

    const auth = readActiveKeyInternal()
    if (!auth) {
      return {
        success: false,
        error:
          'No LLM API key configured. Add one in Settings → AI assist → Ask Compass before asking.'
      }
    }

    // Cancel any in-flight request before starting a new one.
    if (currentController) {
      currentController.abort()
    }
    const controller = new AbortController()
    currentController = controller

    try {
      const context = await gatherContext(question, controller.signal)
      const contextBlock = buildContextBlock(context)
      const userTurnContent = `Context:\n\n${contextBlock}\n\n---\n\nQuestion: ${question}`

      const messages: LlmMessage[] = [...cleanedHistory, { role: 'user', content: userTurnContent }]

      const llmResponse = await callLlm({
        provider: auth.provider,
        apiKey: auth.key,
        model: auth.model,
        system: SYSTEM_PROMPT,
        messages,
        signal: controller.signal
      })

      return {
        success: true,
        answer: llmResponse.text,
        model: llmResponse.model,
        provider: auth.provider,
        inputTokens: llmResponse.inputTokens,
        outputTokens: llmResponse.outputTokens,
        citations: context.map((c, i) => ({
          n: i + 1,
          path: c.path,
          title: c.title,
          snippet: c.snippet,
          score: c.score
        }))
      }
    } catch (err) {
      if (err instanceof LlmAbortError) {
        return { success: false, cancelled: true }
      }
      return { success: false, error: (err as Error).message }
    } finally {
      if (currentController === controller) {
        currentController = null
      }
    }
  })

  // Agentic Ask (Phase 8.5) — Anthropic tool-use loop over local data. The
  // model reads via tools and proposes changes (which land in the Claude Inbox
  // for approval). Anthropic-only; OpenAI keeps the single-shot RAG `ask` path.
  ipcMain.handle('assistant:agent', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'Invalid request payload' }
    }
    const { question, history } = payload as { question?: unknown; history?: unknown }
    if (typeof question !== 'string' || question.trim().length === 0) {
      return { success: false, error: 'Question is required' }
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return {
        success: false,
        error: `Question is too long (max ${MAX_QUESTION_LENGTH} characters)`
      }
    }
    const cleanedHistory: LlmMessage[] = Array.isArray(history)
      ? history
          .filter(
            (m): m is { role: 'user' | 'assistant'; content: string } =>
              !!m &&
              typeof m === 'object' &&
              'role' in m &&
              'content' in m &&
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string'
          )
          .slice(-MAX_HISTORY_TURNS * 2)
      : []

    const auth = readActiveKeyInternal()
    if (!auth) {
      return {
        success: false,
        error:
          'No LLM API key configured. Add one in Settings → AI assist → Ask Compass before asking.'
      }
    }
    if (auth.provider !== 'anthropic') {
      return {
        success: false,
        error:
          'Agentic Ask uses Claude tool-use — switch the active provider to Anthropic in Settings, or use the standard Ask for OpenAI.'
      }
    }

    if (currentController) currentController.abort()
    const controller = new AbortController()
    currentController = controller

    try {
      const result = await runAgent(auth, question, cleanedHistory, controller.signal)
      return {
        success: true,
        answer: result.answer,
        model: result.model,
        provider: auth.provider,
        toolCalls: result.toolCalls,
        proposalIds: result.proposalIds,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens
      }
    } catch (err) {
      if (err instanceof LlmAbortError) {
        return { success: false, cancelled: true }
      }
      return { success: false, error: (err as Error).message }
    } finally {
      if (currentController === controller) {
        currentController = null
      }
    }
  })
}

// Exported for tests.
export const _internal = {
  gatherContext,
  buildContextBlock,
  SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT,
  runAgent
}
