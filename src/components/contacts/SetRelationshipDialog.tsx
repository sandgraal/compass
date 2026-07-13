/**
 * Bulk "set relationship" dialog: one free-text field (with quick-pick chips)
 * applied to every selected contact via `contacts:bulk-set-relationship`.
 * Submitting an empty value clears the relationship on the selection.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Tag } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'

const SUGGESTIONS = ['family', 'friend', 'coworker', 'client', 'neighbor']

export default function SetRelationshipDialog({
  count,
  open,
  busy,
  onClose,
  onSubmit
}: {
  count: number
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (relationship: string) => Promise<void>
}): JSX.Element {
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) setValue('')
  }, [open])

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
            <Tag size={16} className="text-primary" />
            Set relationship on {count} contact{count === 1 ? '' : 's'}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground mb-4">
            Applied to every selected contact. Leave empty to clear.
          </AlertDialog.Description>

          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void onSubmit(value.trim())
            }}
            placeholder="e.g. family, coworker…"
            aria-label="Relationship"
            // biome-ignore lint/a11y/noAutofocus: focusing the only field in a just-opened dialog
            autoFocus
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="mt-2.5 mb-6 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setValue(s)}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-full border transition-colors capitalize',
                  value === s
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/30'
                )}
              >
                {s}
              </button>
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
              onClick={() => void onSubmit(value.trim())}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? 'Applying…' : value.trim() ? 'Apply' : 'Clear relationship'}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
