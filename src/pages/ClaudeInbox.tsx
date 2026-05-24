import {
  Check,
  CheckSquare,
  FileText,
  Inbox,
  ListChecks,
  Receipt,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'

/**
 * Claude Inbox (Phase 8.2) — review surface for proposals Claude enqueued via
 * the MCP. Each proposal is human-approved here before anything is written;
 * approval routes through the validated `claude:approve-proposal` IPC.
 */

type Proposal = ClaudeProposal

const TYPE_META: Record<string, { label: string; icon: JSX.Element }> = {
  task: { label: 'Task', icon: <ListChecks size={15} /> },
  note: { label: 'Note', icon: <FileText size={15} /> },
  txn_tag: { label: 'Transaction tag', icon: <Receipt size={15} /> },
  habit_check: { label: 'Habit', icon: <CheckSquare size={15} /> }
}

function describe(p: Proposal): string {
  const pl = p.payload as Record<string, unknown>
  const s = (k: string): string => (typeof pl[k] === 'string' ? (pl[k] as string) : '')
  switch (p.type) {
    case 'task':
      return `Add “${s('title')}” to the ${s('listType') || 'daily'} list (${s('listDate')})`
    case 'note': {
      const mode = pl.mode === 'append' ? 'Append to' : 'Create'
      return `${mode} note ${s('path')}`
    }
    case 'txn_tag': {
      const parts: string[] = []
      if (s('taxTag')) parts.push(`tax tag ${s('taxTag')}`)
      if (s('category')) parts.push(`category “${s('category')}”`)
      return `Set ${parts.join(' + ') || 'tags'} on transaction #${Number(pl.transactionId)}`
    }
    case 'habit_check':
      return `Mark habit #${Number(pl.habitId)} ${pl.completed === false ? 'not done' : 'done'} on ${s('date')}`
    default:
      return p.type
  }
}

function fmtTime(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export default function ClaudeInbox(): JSX.Element {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()

  const refresh = useCallback(async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const list = await window.api.claude.listProposals('pending')
      setProposals(list)
    } catch {
      toast('Failed to load proposals', 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function approve(p: Proposal): Promise<void> {
    setBusyId(p.id)
    try {
      const res = await window.api.claude.approveProposal(p.id)
      if (res.success) {
        toast('Proposal approved', 'success')
        setProposals((prev) => prev.filter((x) => x.id !== p.id))
      } else {
        toast(res.error || 'Approval failed', 'error')
        void refresh() // reflect a possible status change (e.g. failed)
      }
    } catch {
      toast('Approval failed', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function reject(p: Proposal): Promise<void> {
    const ok = await confirm({
      title: 'Reject proposal?',
      description: describe(p),
      confirmLabel: 'Reject',
      destructive: true
    })
    if (!ok) return
    setBusyId(p.id)
    try {
      const res = await window.api.claude.rejectProposal(p.id)
      if (res.success) {
        toast('Proposal rejected', 'info')
        setProposals((prev) => prev.filter((x) => x.id !== p.id))
      } else {
        toast(res.error || 'Reject failed', 'error')
      }
    } catch {
      toast('Reject failed', 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function clearResolved(): Promise<void> {
    try {
      const res = await window.api.claude.clearResolved()
      toast(`Cleared ${res.cleared} resolved proposal${res.cleared === 1 ? '' : 's'}`, 'info')
    } catch {
      toast('Clear failed', 'error')
    }
  }

  return (
    <div className="p-8 pt-14 max-w-2xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <Inbox size={22} /> Claude Inbox
        </h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh proposals"
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            onClick={() => void clearResolved()}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Trash2 size={14} /> Clear resolved
          </button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-8">
        Changes Claude proposed via the MCP. Nothing is applied until you approve it here.
      </p>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted/50 animate-pulse" />
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
          <Inbox size={40} className="mb-3 opacity-40" />
          <p className="font-medium text-foreground">No pending proposals</p>
          <p className="text-sm mt-1">
            When Claude proposes a change, it shows up here for review.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {proposals.map((p) => {
            const meta = TYPE_META[p.type] ?? { label: p.type, icon: <FileText size={15} /> }
            const busy = busyId === p.id
            return (
              <li
                key={p.id}
                className="rounded-lg border border-border bg-card p-4 flex items-start gap-3"
              >
                <div className="mt-0.5 text-muted-foreground" aria-hidden>
                  {meta.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {meta.label}
                    </span>
                    {p.createdAt && (
                      <span className="text-xs text-muted-foreground/70">
                        {fmtTime(p.createdAt)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-foreground break-words">{describe(p)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void approve(p)}
                    aria-label="Approve proposal"
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors',
                      'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50'
                    )}
                  >
                    <Check size={14} /> Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reject(p)}
                    aria-label="Reject proposal"
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
