/**
 * Ask Compass — in-app RAG assistant page (Tier 2 #7 from the May 2026
 * strategic review).
 *
 * Single-pane chat against the user's own knowledge base. The renderer
 * keeps the conversation history; the main process owns the LLM call,
 * the API key, and the retrieval step. Citations come back as `[N]`
 * markers in the answer with a per-`n` source list the user can click
 * to open the note.
 *
 * Defaults to a no-key empty state that links into Settings →
 * AI assist → Ask Compass.
 */

import { ArrowUp, Bot, ExternalLink, MessageSquare, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'

type AssistantStatus = Awaited<ReturnType<Window['api']['assistant']['getStatus']>>

interface Citation {
  n: number
  path: string
  title: string
  snippet: string
  score: number
}

interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  // Assistant-only metadata.
  citations?: Citation[]
  model?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  error?: string
  pending?: boolean
}

const STORAGE_KEY = 'compass:ask:turns'
const MAX_HISTORY = 24 // 12 user+assistant pairs

function loadStoredTurns(): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ChatTurn[]
    if (!Array.isArray(parsed)) return []
    return parsed.slice(-MAX_HISTORY)
  } catch {
    return []
  }
}

function saveStoredTurns(turns: ChatTurn[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-MAX_HISTORY)))
  } catch {
    /* sessionStorage may be full / disabled */
  }
}

export default function Ask(): JSX.Element {
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [turns, setTurns] = useState<ChatTurn[]>(() => loadStoredTurns())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) return
    void window.api.assistant.getStatus().then(setStatus)
  }, [])

  useEffect(() => {
    saveStoredTurns(turns)
    // Scroll to bottom after each turn change so the latest message is visible.
    requestAnimationFrame(() => {
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [turns])

  useEffect(() => {
    // Honour a pre-filled question from CommandPalette ("Ask…") or URL scheme.
    const pending = sessionStorage.getItem('compass:ask:prefill')
    if (pending) {
      sessionStorage.removeItem('compass:ask:prefill')
      setDraft(pending)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [])

  const hasKey =
    status !== null && status.configuredProviders.length > 0 && status.activeProvider !== null

  async function send() {
    const q = draft.trim()
    if (!q || busy || !hasKey) return

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: q
    }
    const assistantPlaceholder: ChatTurn = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      pending: true
    }
    const nextTurns = [...turns, userTurn, assistantPlaceholder]
    setTurns(nextTurns)
    setDraft('')
    setBusy(true)

    // Build history from existing turns (excluding the placeholder we just added).
    const history = nextTurns
      .slice(0, -1)
      .filter((t) => !t.pending && !t.error && t.content.length > 0)
      .map((t) => ({ role: t.role, content: t.content }))

    try {
      const res = await window.api.assistant.ask({ question: q, history: history.slice(0, -1) })
      if (res.success) {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantPlaceholder.id
              ? {
                  ...t,
                  content: res.answer,
                  pending: false,
                  citations: res.citations,
                  model: res.model,
                  provider: res.provider,
                  inputTokens: res.inputTokens,
                  outputTokens: res.outputTokens
                }
              : t
          )
        )
      } else if (res.cancelled) {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantPlaceholder.id ? { ...t, pending: false, content: '_Cancelled._' } : t
          )
        )
      } else {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantPlaceholder.id
              ? { ...t, pending: false, error: res.error ?? 'Request failed' }
              : t
          )
        )
      }
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (!window.api?.assistant) return
    await window.api.assistant.cancel()
  }

  function clear() {
    setTurns([])
    sessionStorage.removeItem(STORAGE_KEY)
  }

  return (
    <div className="flex flex-col h-full pt-10">
      <div className="px-6 py-4 border-b border-border shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Sparkles size={16} className="text-primary" />
            Ask Compass
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Answers grounded in your own knowledge base. Your API key + the top matching snippets
            are the only things that leave the machine.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status?.activeProvider && (
            <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded">
              {status.activeProvider} · {status.models[status.activeProvider] ?? 'default'}
            </span>
          )}
          {turns.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-border hover:border-destructive text-muted-foreground hover:text-destructive rounded-lg transition-colors"
            >
              <X size={12} /> Clear chat
            </button>
          )}
        </div>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-6">
        {!hasKey ? (
          <NoKeyEmptyState />
        ) : turns.length === 0 ? (
          <FirstTurnEmptyState onPick={(q) => setDraft(q)} />
        ) : (
          <div className="max-w-3xl mx-auto space-y-6">
            {turns.map((t) => (
              <Turn
                key={t.id}
                turn={t}
                onOpenNote={(p) => navigate(`/knowledge?path=${encodeURIComponent(p)}`)}
              />
            ))}
          </div>
        )}
      </div>

      {hasKey && (
        <div className="px-6 py-4 border-t border-border shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                placeholder="Ask anything about your notes… (⌘↵ to send)"
                className="flex-1 bg-secondary/60 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none focus:ring-1 focus:ring-primary resize-none"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="flex items-center gap-1.5 px-3 py-2 bg-destructive/20 hover:bg-destructive/30 text-destructive rounded-lg transition-colors text-sm"
                >
                  <Square size={14} /> Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!draft.trim()}
                  className="flex items-center gap-1.5 px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors text-sm disabled:opacity-40"
                >
                  <ArrowUp size={14} /> Send
                </button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              Compass sends your question + the top-{6} matching knowledge snippets to{' '}
              {status?.activeProvider ?? 'the configured provider'}. Vault entries, task titles, and
              transactions are never included.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function NoKeyEmptyState(): JSX.Element {
  return (
    <div className="max-w-md mx-auto text-center py-16">
      <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center mx-auto mb-4 text-primary">
        <Bot size={26} />
      </div>
      <h2 className="text-base font-semibold text-foreground mb-1">Bring your own LLM key</h2>
      <p className="text-sm text-muted-foreground mb-5">
        Ask Compass is opt-in. Paste an Anthropic or OpenAI API key in Settings to turn on the chat.
        Compass stores it encrypted at rest and sends it only on outbound requests you trigger.
      </p>
      <Link
        to="/settings"
        className="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors"
      >
        <Sparkles size={14} /> Open Settings → AI assist
      </Link>
    </div>
  )
}

const STARTER_PROMPTS = [
  'What recurring subscriptions are due this week?',
  'Summarize my finance notes for last month.',
  'List my open work projects with their next milestones.',
  'What are my current health-related action items?'
]

function FirstTurnEmptyState({ onPick }: { onPick: (q: string) => void }): JSX.Element {
  return (
    <div className="max-w-2xl mx-auto py-12 space-y-6">
      <div className="text-center">
        <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center mx-auto mb-4 text-primary">
          <MessageSquare size={26} />
        </div>
        <h2 className="text-base font-semibold text-foreground">Ask anything about your notes</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Compass finds the relevant snippets, hands them to the model, and cites the source notes
          inline. Try one of these to start:
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="text-left text-sm px-4 py-3 rounded-lg border border-border bg-card/40 hover:bg-card hover:border-primary/40 transition-colors text-foreground"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

function Turn({
  turn,
  onOpenNote
}: {
  turn: ChatTurn
  onOpenNote: (path: string) => void
}): JSX.Element {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-primary/15 border border-primary/20 rounded-lg px-4 py-2.5 text-sm text-foreground whitespace-pre-wrap">
          {turn.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-card/60 border border-border rounded-lg px-4 py-3">
        {turn.pending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse [animation-delay:300ms]" />
            </div>
            Thinking…
          </div>
        ) : turn.error ? (
          <div className="text-sm text-destructive">{turn.error}</div>
        ) : (
          <div
            className={cn(
              'text-sm text-foreground whitespace-pre-wrap leading-6',
              'prose prose-invert max-w-none prose-sm'
            )}
          >
            {turn.content}
          </div>
        )}
        {turn.model && !turn.pending && !turn.error && (
          <div className="mt-3 pt-2 border-t border-border/40 flex items-center gap-3 text-[10px] text-muted-foreground">
            <span>
              {turn.provider} · {turn.model}
            </span>
            {turn.inputTokens != null && (
              <span>
                {turn.inputTokens} in / {turn.outputTokens ?? 0} out
              </span>
            )}
          </div>
        )}
      </div>
      {turn.citations && turn.citations.length > 0 && (
        <div className="bg-secondary/40 border border-border/60 rounded-lg px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Sources</p>
          <ul className="space-y-2">
            {turn.citations.map((c) => (
              <li key={c.n} className="text-xs">
                <button
                  type="button"
                  onClick={() => onOpenNote(c.path)}
                  className="group flex items-baseline gap-2 text-left w-full hover:text-primary"
                >
                  <span className="text-primary tabular-nums">[{c.n}]</span>
                  <span className="flex-1">
                    <span className="font-medium text-foreground group-hover:text-primary">
                      {c.title}
                    </span>{' '}
                    <span className="text-muted-foreground">— {c.path}</span>
                    <span className="block text-muted-foreground/80 mt-0.5 line-clamp-2">
                      {c.snippet}
                    </span>
                  </span>
                  <ExternalLink
                    size={10}
                    className="text-muted-foreground/60 group-hover:text-primary"
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
