/**
 * Collapsible "possible duplicates" review queue for tracked merchants/places —
 * the merchant/place analogue of the Contacts duplicates panel. Review-only:
 * nothing merges without a click (see electron/lib/place-dedupe.ts — there's
 * no auto-merge tier here, unlike contacts' shared-email/phone tier).
 */
import { Store } from 'lucide-react'
import { useEffect, useState } from 'react'

const isElectron = (): boolean => typeof window !== 'undefined' && !!window.api

export default function PossibleDuplicatesPanel({
  kind,
  onReview
}: {
  kind: 'merchant' | 'place'
  /** Fired when the user clicks "Merge…" on a pair — the parent resolves live
   * stats and opens MergePlacesDialog. */
  onReview: (a: DuplicatePlaceSummary, b: DuplicatePlaceSummary) => void
}): JSX.Element | null {
  const [dupes, setDupes] = useState<DuplicatePlacePair[]>([])
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    window.api.places
      .duplicates(kind)
      .then(setDupes)
      .catch((err) => console.error(`[${kind}s] duplicates failed`, err))
  }, [kind])

  async function dismiss(pair: DuplicatePlacePair): Promise<void> {
    if (!isElectron()) return
    setBusy(true)
    try {
      await window.api.places.dismissDuplicate(pair.a.externalId, pair.b.externalId)
      setDupes((prev) => prev.filter((p) => p !== pair))
    } catch (err) {
      console.error(`[${kind}s] dismiss failed`, err)
    } finally {
      setBusy(false)
    }
  }

  if (dupes.length === 0) return null

  return (
    <div className="rounded-lg border border-border bg-card/40 mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
      >
        <Store size={14} className="text-primary shrink-0" />
        <span className="text-sm font-medium text-foreground">
          Possible duplicates ({dupes.length})
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {expanded ? 'Hide' : 'Review'}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {dupes.slice(0, 20).map((pair) => (
            <div
              key={`${pair.a.id}::${pair.b.id}`}
              className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2"
            >
              <div className="flex-1 min-w-0 grid grid-cols-2 gap-3">
                {[pair.a, pair.b].map((side) => (
                  <div key={side.id} className="min-w-0">
                    <p className="text-sm text-foreground capitalize truncate">{side.name}</p>
                    {side.category && (
                      <p className="text-xs text-muted-foreground truncate">{side.category}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onReview(pair.a, pair.b)}
                  title="Pick which one survives, then merge"
                  className="text-xs px-2.5 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded-lg transition-colors disabled:opacity-50"
                >
                  Merge…
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void dismiss(pair)}
                  className="text-xs px-2.5 py-1.5 border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground rounded-lg transition-colors disabled:opacity-50"
                >
                  Not the same
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
