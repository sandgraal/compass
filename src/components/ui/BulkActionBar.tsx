/**
 * Shared multi-select toolbar: "N selected", the caller's action buttons, and a
 * trailing Clear. Rendered only while a selection exists (the caller guards on
 * `count > 0` or relies on the built-in null return). Used by People, the
 * Merchants/Places lists, and Contacts.
 */
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

export default function BulkActionBar({
  count,
  onClear,
  children,
  className
}: {
  count: number
  onClear: () => void
  children: React.ReactNode
  className?: string
}): JSX.Element | null {
  if (count <= 0) return null
  return (
    <div
      className={cn(
        'sticky top-12 z-10 mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-sm',
        className
      )}
    >
      <span className="text-sm text-foreground">{count} selected</span>
      {children}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <X size={12} /> Clear
      </button>
    </div>
  )
}
