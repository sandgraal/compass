/**
 * Bulk-merge dialog: pick the survivor among the selected contacts, then fold
 * the rest into it via `contacts:merge`. The pre-selected radio comes from the
 * backend's deterministic ranking (`contacts:suggest-survivor`) — the same one
 * the auto-dedupe tier uses — so the default matches what an automatic merge
 * would have picked.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { GitMerge } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { useToast } from '../ui/Toast'

/**
 * The slice of a contact the dialog actually renders — structural, so the
 * duplicates panel can feed `DuplicateContactSummary` pairs straight in
 * without materializing full ContactRecords. Emails/phones are only counted,
 * so the element type is deliberately opaque (ContactRecord carries objects,
 * the duplicate summaries carry strings).
 */
export type MergeCandidate = {
  id: number
  displayName: string
  source: string
  emails: readonly unknown[]
  phones: readonly unknown[]
  createdAt?: number | null
}

export default function MergeContactsDialog({
  contacts,
  open,
  onClose,
  onMerged
}: {
  contacts: MergeCandidate[]
  open: boolean
  onClose: () => void
  /** Called after a successful merge; the parent reloads and opens the survivor. */
  onMerged: (survivorId: number) => Promise<void>
}): JSX.Element {
  const [survivorId, setSurvivorId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const ids = useMemo(() => contacts.map((c) => c.id), [contacts])
  // The parent passes `[...selectedRows.values()]`, a fresh array every
  // render — depending on `ids` directly would re-fire suggestSurvivor on
  // every unrelated re-render. Depend on a stable key derived from the ids
  // instead, so the effect only re-runs when the selection actually changes.
  const idsKey = useMemo(() => [...ids].sort((a, b) => a - b).join(','), [ids])

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the stable `idsKey`, not `ids` — `contacts` (and thus `ids`) is a fresh array every parent render, so depending on `ids` directly would re-fire suggestSurvivor on every unrelated re-render
  useEffect(() => {
    if (!open || ids.length < 2) return
    let cancelled = false
    // Fall back to the first selected contact if the suggestion call fails.
    setSurvivorId(ids[0] ?? null)
    window.api.contacts
      .suggestSurvivor(ids)
      .then((r) => {
        // The selection may have changed while this request was in flight —
        // an older response must never clobber a newer selection's default.
        if (!cancelled) setSurvivorId(r.survivorId)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, idsKey])

  async function merge(): Promise<void> {
    if (survivorId == null || busy) return
    setBusy(true)
    try {
      const loserIds = contacts.map((c) => c.id).filter((id) => id !== survivorId)
      const r = await window.api.contacts.merge(survivorId, loserIds)
      if (r.success) {
        const name = contacts.find((c) => c.id === survivorId)?.displayName ?? 'the survivor'
        toast(`Merged ${loserIds.length + 1} contacts into ${name}.`, 'success')
        await onMerged(survivorId)
      } else {
        toast('Merge failed.', 'error')
      }
    } catch (err) {
      console.error('[contacts] bulk merge failed', err)
      toast('Merge failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in" />
        <AlertDialog.Content
          className={cn(
            'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-md bg-card border border-border rounded-xl p-6 shadow-xl',
            'data-[state=open]:animate-fade-in focus:outline-none'
          )}
        >
          <AlertDialog.Title className="text-base font-semibold text-foreground mb-2 flex items-center gap-2">
            <GitMerge size={16} className="text-primary" />
            Merge {contacts.length} contacts
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground mb-4">
            Pick which contact to keep. Emails, phones, and addresses are combined; notes are
            appended; the others are permanently deleted and won't re-import.
          </AlertDialog.Description>

          <div className="max-h-64 overflow-y-auto space-y-1.5 mb-6">
            {contacts.map((c) => (
              <label
                key={c.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
                  survivorId === c.id
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border hover:border-primary/30'
                )}
              >
                <input
                  type="radio"
                  name="merge-survivor"
                  checked={survivorId === c.id}
                  onChange={() => setSurvivorId(c.id)}
                  className="h-3.5 w-3.5 accent-primary cursor-pointer shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground truncate">
                    {c.displayName}
                  </span>
                  <span className="block text-xs text-muted-foreground capitalize">
                    {c.source}
                    {` · ${c.emails.length} email${c.emails.length === 1 ? '' : 's'}`}
                    {` · ${c.phones.length} phone${c.phones.length === 1 ? '' : 's'}`}
                    {c.createdAt != null &&
                      ` · added ${new Date(c.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        year: 'numeric'
                      })}`}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="flex gap-3 justify-end">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={merge}
              disabled={busy || survivorId == null}
              className="px-4 py-2 text-sm rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? 'Merging…' : `Merge ${contacts.length} contacts`}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
