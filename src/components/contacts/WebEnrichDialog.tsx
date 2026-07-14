/**
 * "Enrich from web" dialog — the consent-gated, review-everything front end for
 * `contacts:web-enrich`.
 *
 * Phases: consent (shows the EXACT outbound payload + free-text hints) →
 * searching (cancellable) → candidates (disambiguation pick, re-runs) →
 * review (per-item checkboxes; unverified-source items default UNchecked) →
 * applied. `no-key` / `error` / `none` are terminal side-states.
 *
 * Nothing is written until the user hits Apply, and even then the accepted ids
 * are resolved against the main process's own cached run — this component
 * never sends field values over IPC.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { AlertTriangle, ExternalLink, Globe, ShieldQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { useToast } from '../ui/Toast'

type Phase =
  | 'consent'
  | 'searching'
  | 'candidates'
  | 'review'
  | 'applied'
  | 'no-key'
  | 'error'
  | 'none'

const KIND_LABELS: Record<WebEnrichProposal['kind'], string> = {
  jobTitle: 'Job title',
  org: 'Organization',
  birthday: 'Birthday',
  url: 'Website',
  location: 'Location',
  bio: 'Bio',
  link: 'Link',
  fact: 'Fact'
}

const CONFIDENCE_STYLES: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-primary/10 text-primary',
  medium: 'bg-secondary text-muted-foreground',
  low: 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
}

// Same rationale as `safeHref` in Contacts.tsx — never render a non-http(s)
// value as a clickable href.
const safeHref = (value: string): string | undefined =>
  /^https?:\/\//i.test(value) ? value : undefined

export default function WebEnrichDialog({
  contact,
  open,
  onClose,
  onApplied,
  progress,
  onStopAll
}: {
  contact: ContactRecord
  open: boolean
  onClose: () => void
  /** Called after a successful apply; the parent re-fetches the contact. */
  onApplied: () => Promise<void>
  /** Bulk-queue chrome: "contact k of n". Close advances; onStopAll aborts. */
  progress?: { index: number; total: number }
  onStopAll?: () => void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('consent')
  const [hints, setHints] = useState('')
  const [candidates, setCandidates] = useState<WebEnrichCandidate[]>([])
  const [pickedCandidate, setPickedCandidate] = useState<string | null>(null)
  const [proposals, setProposals] = useState<WebEnrichProposal[]>([])
  const [runId, setRunId] = useState('')
  const [matchConfidence, setMatchConfidence] = useState<'high' | 'medium' | 'low'>('high')
  const [searchedAs, setSearchedAs] = useState('')
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [message, setMessage] = useState('')
  const [searchCount, setSearchCount] = useState(0)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applied, setApplied] = useState<{ fields: string[]; findings: number } | null>(null)
  const { toast } = useToast()
  const navigate = useNavigate()

  // Fresh dialog every open + up-front key check so the consent screen never
  // promises a search that can't run.
  useEffect(() => {
    if (!open) return
    setPhase('consent')
    setHints('')
    setCandidates([])
    setPickedCandidate(null)
    setProposals([])
    setRunId('')
    setMessage('')
    setApplied(null)
    window.api.assistant
      .getStatus()
      .then((s) => {
        if (!s.configuredProviders.includes('anthropic')) setPhase('no-key')
      })
      .catch(() => {})
  }, [open])

  async function run(candidateHint?: string): Promise<void> {
    setPhase('searching')
    try {
      const r = await window.api.contacts.webEnrich({
        contactId: contact.id,
        hints: hints.trim() || undefined,
        candidateHint
      })
      if (!r.success) {
        if (r.cancelled) {
          setPhase('consent')
          return
        }
        if (r.needsKey) {
          setPhase('no-key')
          return
        }
        setMessage(r.error)
        setPhase('error')
        return
      }
      setSearchedAs(r.searchedAs)
      setSearchCount(r.searchCount)
      if (r.outcome === 'none') {
        setMessage(r.message)
        setPhase('none')
        return
      }
      if (r.outcome === 'candidates') {
        setCandidates(r.candidates)
        setPickedCandidate(null)
        setPhase('candidates')
        return
      }
      setRunId(r.runId)
      setProposals(r.proposals)
      setMatchConfidence(r.matchConfidence)
      // Items whose citation didn't appear in an actual search result start
      // unchecked — the user has to consciously opt into unverified claims.
      setChecked(new Set(r.proposals.filter((p) => p.sourceVerified).map((p) => p.id)))
      setPhase('review')
    } catch (err) {
      console.error('[contacts] web enrich failed', err)
      setMessage('Search failed unexpectedly.')
      setPhase('error')
    }
  }

  async function cancelSearch(): Promise<void> {
    try {
      await window.api.contacts.webEnrichCancel()
    } catch {
      /* the run result handles the abort */
    }
    setPhase('consent')
  }

  async function apply(): Promise<void> {
    if (applyBusy) return
    setApplyBusy(true)
    try {
      const r = await window.api.contacts.webEnrichApply({ runId, accepted: [...checked] })
      if (r.success && r.applied) {
        setApplied(r.applied)
        setPhase('applied')
        toast(
          `Applied ${r.applied.fields.length + r.applied.findings} item${
            r.applied.fields.length + r.applied.findings === 1 ? '' : 's'
          } to ${contact.displayName}.`,
          'success'
        )
        await onApplied()
      } else {
        toast(r.error ?? 'Apply failed.', 'error')
      }
    } catch (err) {
      console.error('[contacts] web enrich apply failed', err)
      toast('Apply failed.', 'error')
    } finally {
      setApplyBusy(false)
    }
  }

  function handleClose(): void {
    // Cancel on EVERY close, not just mid-search: it also invalidates the
    // main-process cached run, so a discarded review can never be applied
    // later with a stale runId.
    void window.api.contacts.webEnrichCancel().catch(() => {})
    onClose()
  }

  const toggle = (id: number): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const coreProposals = proposals.filter((p) => p.writesToContact)
  const webProposals = proposals.filter((p) => !p.writesToContact)

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in" />
        <AlertDialog.Content
          className={cn(
            'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-lg bg-card border border-border rounded-xl p-6 shadow-xl',
            'data-[state=open]:animate-fade-in focus:outline-none'
          )}
        >
          <AlertDialog.Title className="text-base font-semibold text-foreground mb-2 flex items-center gap-2">
            <Globe size={16} className="text-primary" />
            Enrich from web
            {progress && (
              <span className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
                {progress.index} of {progress.total}
                {onStopAll && (
                  <button
                    type="button"
                    onClick={() => {
                      void window.api.contacts.webEnrichCancel().catch(() => {})
                      onStopAll()
                    }}
                    className="text-destructive hover:underline"
                  >
                    Stop all
                  </button>
                )}
              </span>
            )}
          </AlertDialog.Title>

          {phase === 'no-key' && (
            <>
              <AlertDialog.Description className="text-sm text-muted-foreground mb-6">
                Web enrichment uses Anthropic's web search with your own API key, and no Anthropic
                key is configured yet. Add one in Settings → AI assist, then come back.
              </AlertDialog.Description>
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={handleClose} label="Close" />
                <PrimaryButton
                  onClick={() => {
                    handleClose()
                    navigate('/settings')
                  }}
                  label="Open Settings"
                />
              </div>
            </>
          )}

          {phase === 'consent' && (
            <>
              <AlertDialog.Description className="text-sm text-muted-foreground mb-4">
                Compass will search the public web for this person. Exactly this will be sent to
                Anthropic's web search, using your API key — nothing is saved without your review.
              </AlertDialog.Description>
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 mb-3 space-y-1">
                <ConsentRow label="Name" value={contact.displayName} />
                {contact.org && <ConsentRow label="Organization" value={contact.org} />}
                {contact.jobTitle && <ConsentRow label="Job title" value={contact.jobTitle} />}
              </div>
              <textarea
                value={hints}
                onChange={(e) => setHints(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder='Optional hint to find the right person — e.g. "lives in Austin, works in biotech"'
                className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 resize-none mb-1"
              />
              <p className="text-xs text-muted-foreground mb-6">
                The contact's emails and phone numbers are never sent.
              </p>
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={handleClose} label="Cancel" />
                <PrimaryButton onClick={() => void run()} label="Search the web" />
              </div>
            </>
          )}

          {phase === 'searching' && (
            <>
              <AlertDialog.Description className="text-sm text-muted-foreground mb-6 flex items-center gap-2">
                <Globe size={14} className="text-primary animate-pulse" />
                Searching the web for {contact.displayName}…
              </AlertDialog.Description>
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={() => void cancelSearch()} label="Cancel" />
              </div>
            </>
          )}

          {phase === 'candidates' && (
            <>
              <AlertDialog.Description className="text-sm text-muted-foreground mb-4">
                The web has more than one plausible “{contact.displayName}”. Which one is this
                contact?
              </AlertDialog.Description>
              <div className="max-h-64 overflow-y-auto space-y-1.5 mb-6">
                {candidates.map((c) => (
                  <label
                    key={`${c.name}|${c.descriptor}`}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
                      pickedCandidate === c.descriptor
                        ? 'border-primary/60 bg-primary/10'
                        : 'border-border hover:border-primary/30'
                    )}
                  >
                    <input
                      type="radio"
                      name="web-enrich-candidate"
                      checked={pickedCandidate === c.descriptor}
                      onChange={() => setPickedCandidate(c.descriptor)}
                      className="h-3.5 w-3.5 accent-primary cursor-pointer shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground truncate">
                        {c.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">{c.descriptor}</span>
                    </span>
                    {c.sourceUrl && <SourceLink url={c.sourceUrl} />}
                  </label>
                ))}
              </div>
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={() => setPhase('consent')} label="None of these" />
                <PrimaryButton
                  onClick={() => pickedCandidate && void run(pickedCandidate)}
                  disabled={!pickedCandidate}
                  label="Search this person"
                />
              </div>
            </>
          )}

          {phase === 'review' && (
            <>
              <AlertDialog.Description className="text-sm text-muted-foreground mb-3">
                Found for <span className="text-foreground">{searchedAs}</span> ({searchCount} web
                search{searchCount === 1 ? '' : 'es'}). Check what to keep — nothing else is saved.
              </AlertDialog.Description>
              {matchConfidence !== 'high' && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 mb-3">
                  <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-foreground">
                    The model is only <span className="font-medium">{matchConfidence}</span>{' '}
                    confident this is the right person. Review carefully, or re-run with a hint.
                  </p>
                </div>
              )}
              <div className="max-h-[50vh] overflow-y-auto space-y-4 mb-4 pr-1">
                {coreProposals.length > 0 && (
                  <ProposalGroup title="Updates to this contact">
                    {coreProposals.map((p) => (
                      <ProposalRow key={p.id} p={p} checked={checked.has(p.id)} onToggle={toggle} />
                    ))}
                  </ProposalGroup>
                )}
                {webProposals.length > 0 && (
                  <ProposalGroup title="Web presence (saved alongside the contact)">
                    {webProposals.map((p) => (
                      <ProposalRow key={p.id} p={p} checked={checked.has(p.id)} onToggle={toggle} />
                    ))}
                  </ProposalGroup>
                )}
              </div>
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={handleClose} label="Discard" />
                <PrimaryButton
                  onClick={() => void apply()}
                  disabled={applyBusy || checked.size === 0}
                  label={applyBusy ? 'Applying…' : `Apply ${checked.size} selected`}
                />
              </div>
            </>
          )}

          {phase === 'applied' && applied && (
            <>
              <AlertDialog.Description className="text-sm text-muted-foreground mb-6">
                Done — {applied.fields.length} contact field{applied.fields.length === 1 ? '' : 's'}{' '}
                updated and {applied.findings} web finding{applied.findings === 1 ? '' : 's'} saved
                to {contact.displayName}.
              </AlertDialog.Description>
              <div className="flex gap-3 justify-end">
                <PrimaryButton onClick={handleClose} label="Done" />
              </div>
            </>
          )}

          {(phase === 'error' || phase === 'none') && (
            <>
              <AlertDialog.Description
                className={cn(
                  'text-sm mb-6',
                  phase === 'error' ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {message}
              </AlertDialog.Description>
              <div className="flex gap-3 justify-end">
                <CancelButton onClick={handleClose} label="Close" />
                <PrimaryButton onClick={() => setPhase('consent')} label="Try again" />
              </div>
            </>
          )}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function ConsentRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <p className="text-sm">
      <span className="text-xs text-muted-foreground uppercase tracking-wider mr-2">{label}</span>
      <span className="text-foreground">{value}</span>
    </p>
  )
}

function ProposalGroup({
  title,
  children
}: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function ProposalRow({
  p,
  checked,
  onToggle
}: {
  p: WebEnrichProposal
  checked: boolean
  onToggle: (id: number) => void
}): JSX.Element {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
        checked ? 'border-primary/60 bg-primary/10' : 'border-border hover:border-primary/30'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(p.id)}
        className="h-3.5 w-3.5 accent-primary cursor-pointer shrink-0 mt-1"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {p.kind === 'link' && p.label ? p.label : KIND_LABELS[p.kind]}
          </span>
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full',
              CONFIDENCE_STYLES[p.confidence]
            )}
          >
            {p.confidence}
          </span>
          {!p.sourceVerified && (
            <span
              title="The cited source did not appear in the actual search results — verify before accepting"
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400"
            >
              <ShieldQuestion size={10} /> unverified
            </span>
          )}
        </span>
        {p.currentValue && (
          <span className="block text-xs text-muted-foreground line-through truncate">
            {p.currentValue}
          </span>
        )}
        <span className="block text-sm text-foreground break-words">{p.proposedValue}</span>
      </span>
      {p.sourceUrl && <SourceLink url={p.sourceUrl} />}
    </label>
  )
}

function SourceLink({ url }: { url: string }): JSX.Element | null {
  const href = safeHref(url)
  if (!href) return null
  let host = url
  try {
    host = new URL(href).hostname.replace(/^www\./, '')
  } catch {
    /* show the raw url */
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={href}
      className="shrink-0 flex items-center gap-1 text-xs text-primary hover:underline mt-0.5"
    >
      <ExternalLink size={11} />
      {host}
    </a>
  )
}

function CancelButton({ onClick, label }: { onClick: () => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg"
    >
      {label}
    </button>
  )
}

function PrimaryButton({
  onClick,
  label,
  disabled
}: { onClick: () => void; label: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-2 text-sm rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
    >
      {label}
    </button>
  )
}
