import { Download, ExternalLink, RefreshCw } from 'lucide-react'
import { useUpdateStatus } from '../../hooks/useUpdateStatus'
import { cn } from '../../lib/utils'

export function UpdateBanner(): JSX.Element | null {
  const status = useUpdateStatus()

  if (!status.phase || status.phase === 'not-available') return null

  return (
    <output
      aria-live={status.phase === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={cn(
        'flex items-center gap-2.5 shrink-0 h-9 px-4 text-xs border-b',
        status.phase === 'available'
          ? 'bg-amber-500/10 border-amber-500/20 text-amber-200'
          : status.phase === 'error'
            ? 'bg-destructive/10 border-destructive/20 text-destructive-foreground'
            : 'bg-primary/10 border-primary/20 text-foreground/80'
      )}
    >
      {status.phase === 'checking' && (
        <>
          <RefreshCw size={12} className="animate-spin shrink-0 opacity-60" />
          <span>Checking for updates…</span>
        </>
      )}

      {/*
       * autoDownload is off (see electron/ipc/updater.ts) because CI publishes
       * unsigned macOS builds and Squirrel.Mac silently refuses to install them.
       * The banner now points the user at the GitHub release for a manual
       * .dmg install instead of pretending the in-app updater works.
       */}
      {status.phase === 'available' && status.version && (
        <>
          <Download size={12} className="shrink-0 opacity-70" />
          <span>
            Update <span className="font-semibold">v{status.version}</span> available
          </span>
          <button
            type="button"
            onClick={() => status.version && window.api.updater.openReleasePage(status.version)}
            className="ml-auto shrink-0 px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-200 font-medium transition-colors inline-flex items-center gap-1.5"
          >
            View on GitHub
            <ExternalLink size={11} className="opacity-70" />
          </button>
        </>
      )}

      {status.phase === 'error' && (
        <>
          <span className="opacity-60">Update check failed:</span>
          <span className="truncate">{status.errorMessage}</span>
        </>
      )}
    </output>
  )
}
