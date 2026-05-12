import { Download, RefreshCw, RotateCcw } from 'lucide-react'
import { useUpdateStatus } from '../../hooks/useUpdateStatus'
import { cn } from '../../lib/utils'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB/s`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`
}

export function UpdateBanner(): JSX.Element | null {
  const status = useUpdateStatus()

  if (!status.phase || status.phase === 'not-available') return null

  return (
    <output
      aria-live={status.phase === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={cn(
        'flex items-center gap-2.5 shrink-0 h-9 px-4 text-xs border-b',
        status.phase === 'downloaded'
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

      {status.phase === 'available' && (
        <>
          <Download size={12} className="shrink-0 opacity-60" />
          <span>
            Update <span className="font-semibold">v{status.version}</span> available — downloading…
          </span>
        </>
      )}

      {status.phase === 'downloading' && (
        <>
          <Download size={12} className="shrink-0 opacity-60" />
          <span className="shrink-0">
            Downloading update <span className="font-semibold">v{status.version ?? ''}</span>
          </span>
          <div className="flex-1 max-w-32 h-1 bg-primary/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${Math.round(status.percent ?? 0)}%` }}
            />
          </div>
          <span className="opacity-60 tabular-nums">{Math.round(status.percent ?? 0)}%</span>
          {!!status.bytesPerSecond && (
            <span className="opacity-40 tabular-nums">{formatBytes(status.bytesPerSecond)}</span>
          )}
        </>
      )}

      {status.phase === 'downloaded' && (
        <>
          <RotateCcw size={12} className="shrink-0 opacity-70" />
          <span>
            Update <span className="font-semibold">v{status.version}</span> ready to install
          </span>
          <button
            type="button"
            onClick={() => window.api.updater.installAndRestart()}
            className="ml-auto shrink-0 px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-200 font-medium transition-colors"
          >
            Restart to Install
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
