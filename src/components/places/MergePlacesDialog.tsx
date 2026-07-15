/**
 * Bulk-merge dialog for tracked merchants/places: pick the survivor among the
 * selected rows, then fold the rest into it via `places.merge`. The
 * pre-selected radio comes from `places.suggestSurvivor` — the same
 * deterministic ranking `listPlaceDuplicates` uses for its candidates — so
 * the default matches what a careful manual pick would choose. Mirrors
 * `MergeContactsDialog.tsx`; kept as a parallel component rather than
 * generalizing that one, since the fields shown differ (spend/visits vs.
 * emails/phones) and the contacts merge flow is already shipped and tested.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { GitMerge } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { useToast } from '../ui/Toast'

/** The slice of a tracked merchant/place the dialog renders. `secondary` is a
 * pre-formatted display line (e.g. "$1,240 · 12 txns" or "8 visits") — the
 * caller already has the live stats loaded, so the dialog doesn't re-derive them. */
export type MergePlaceCandidate = {
  id: number
  name: string
  category: string | null
  secondary: string
}

export default function MergePlacesDialog({
  kind,
  candidates,
  open,
  onClose,
  onMerged
}: {
  kind: 'merchant' | 'place'
  candidates: MergePlaceCandidate[]
  open: boolean
  onClose: () => void
  /** Called after a successful merge; the parent reloads and opens the survivor. */
  onMerged: (survivorId: number) => Promise<void>
}): JSX.Element {
  const [survivorId, setSurvivorId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const noun = kind === 'merchant' ? 'merchants' : 'places'

  const ids = useMemo(() => candidates.map((c) => c.id), [candidates])
  // The parent passes a fresh array every render — depend on a stable key
  // derived from the ids instead, so the effect only re-runs when the
  // selection actually changes (same reasoning as MergeContactsDialog).
  const idsKey = useMemo(() => [...ids].sort((a, b) => a - b).join(','), [ids])

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the stable `idsKey`, not `ids` — see MergeContactsDialog for the identical reasoning
  useEffect(() => {
    if (!open || ids.length < 2) return
    let cancelled = false
    setSurvivorId(ids[0] ?? null)
    window.api.places
      .suggestSurvivor(kind, ids)
      .then((r) => {
        if (!cancelled) setSurvivorId(r.survivorId)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, idsKey, kind])

  async function merge(): Promise<void> {
    if (survivorId == null || busy) return
    setBusy(true)
    try {
      const loserIds = candidates.map((c) => c.id).filter((id) => id !== survivorId)
      const r = await window.api.places.merge(kind, survivorId, loserIds)
      if (r.success) {
        const name = candidates.find((c) => c.id === survivorId)?.name ?? 'the survivor'
        toast(`Merged ${loserIds.length + 1} ${noun} into ${name}.`, 'success')
        await onMerged(survivorId)
      } else {
        toast('Merge failed.', 'error')
      }
    } catch (err) {
      console.error(`[${noun}] bulk merge failed`, err)
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
            Merge {candidates.length} {noun}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground mb-4">
            Pick which one to keep. Category, address, website, and notes are combined; the others
            are permanently deleted — future transactions and visits still attribute to the one you
            keep.
          </AlertDialog.Description>

          <div className="max-h-64 overflow-y-auto space-y-1.5 mb-6">
            {candidates.map((c) => (
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
                  <span className="block text-sm font-medium text-foreground truncate capitalize">
                    {c.name}
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {c.category ? `${c.category} · ` : ''}
                    {c.secondary}
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
              {busy ? 'Merging…' : `Merge ${candidates.length} ${noun}`}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
