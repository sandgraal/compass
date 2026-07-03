import type { DataRightsDomain } from '../../lib/data-rights'
import type { DataRightsProgress as Progress } from '../../lib/data-rights-status'
import { cn } from '../../lib/utils'

interface DataRightsProgressProps {
  progress: Progress
  onJumpToDomain: (domain: DataRightsDomain) => void
}

export default function DataRightsProgress({
  progress,
  onJumpToDomain
}: DataRightsProgressProps): JSX.Element {
  const pct = progress.total > 0 ? Math.round((progress.imported / progress.total) * 100) : 0

  return (
    <div className="mb-6 rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {progress.imported} of {progress.total} sources imported
        </p>
        <p className="text-xs text-muted-foreground">{pct}%</p>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(
          Object.entries(progress.byDomain) as [
            DataRightsDomain,
            { total: number; imported: number }
          ][]
        )
          .filter(([, d]) => d.total > 0)
          .map(([domain, d]) => (
            <button
              key={domain}
              type="button"
              onClick={() => onJumpToDomain(domain)}
              className={cn(
                'rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors',
                'hover:border-foreground/30 hover:text-foreground'
              )}
            >
              {domain} {d.imported}/{d.total}
            </button>
          ))}
      </div>
    </div>
  )
}
