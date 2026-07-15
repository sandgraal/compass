import { ArrowUpRight, CheckCircle2, Circle, Clock3, Sparkles, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { DataRightsSource } from '../../lib/data-rights'
import type { DataRightsStatus } from '../../lib/data-rights-status'
import { getIntegrationMeta } from '../../lib/integration-registry'
import { getIntegrationSetup } from '../../lib/integration-setup'
import { cn } from '../../lib/utils'

interface DataRightsCardProps {
  source: DataRightsSource
  status: DataRightsStatus
  automatable: boolean
  automating: boolean
  automateDisabled: boolean
  onAutomate: () => void
  onMarkRequested: () => void
  onClearRequested: () => void
}

const STATUS_META: Record<
  DataRightsStatus,
  { label: string; icon: JSX.Element; className: string }
> = {
  imported: {
    label: 'Imported',
    icon: <CheckCircle2 size={12} />,
    className: 'text-emerald-500'
  },
  requested: {
    label: 'Requested',
    icon: <Clock3 size={12} />,
    className: 'text-amber-500'
  },
  'not-started': {
    label: 'Not started',
    icon: <Circle size={12} />,
    className: 'text-muted-foreground/50'
  }
}

export default function DataRightsCard({
  source,
  status,
  automatable,
  automating,
  automateDisabled,
  onAutomate,
  onMarkRequested,
  onClearRequested
}: DataRightsCardProps): JSX.Element {
  const statusMeta = STATUS_META[status]

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{source.name}</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn('flex items-center gap-1 text-[10px] font-medium', statusMeta.className)}
            title={statusMeta.label}
          >
            {statusMeta.icon}
          </span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            {source.method === 'live' ? 'Connect' : source.format}
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{source.what}</p>
      <p className="text-xs text-muted-foreground/80">{source.how}</p>

      <p className="flex items-start gap-1 text-[11px] text-foreground/70">
        <Sparkles size={11} className="mt-0.5 shrink-0 text-primary/70" />
        {source.payoffLink ? (
          <Link to={source.payoffLink} className="hover:underline">
            {source.payoff}
          </Link>
        ) : (
          source.payoff
        )}
      </p>

      {source.relatedIntegrationId &&
        (() => {
          const related = getIntegrationMeta(source.relatedIntegrationId)
          if (!related) return null
          const needsRelay = getIntegrationSetup(source.relatedIntegrationId)?.requiresRelay
          return (
            <p className="text-[11px] text-muted-foreground/70">
              Also available live via{' '}
              <Link to="/integrations" className="text-primary hover:underline">
                {related.name}
              </Link>
              {needsRelay ? ' (needs a self-hosted relay)' : ''}
            </p>
          )
        })()}

      {source.method === 'live' ? (
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          {status === 'imported' ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
              <CheckCircle2 size={13} /> Connected
            </span>
          ) : (
            <Link
              to="/integrations"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Connect <ArrowUpRight size={13} />
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-[11px] text-primary/80">↳ {source.intoCompass}</span>
          {source.url && (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {source.method === 'export' ? 'Download' : 'Request'} <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      )}

      {source.method !== 'live' && status !== 'imported' && (
        <button
          type="button"
          onClick={status === 'requested' ? onClearRequested : onMarkRequested}
          className="self-start text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          {status === 'requested' ? 'Clear requested' : 'Mark as requested'}
        </button>
      )}

      {source.adapterId && automatable && (
        <button
          type="button"
          onClick={onAutomate}
          disabled={automateDisabled}
          title="Compass opens a window, you log in, and it fetches this for you"
          className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
        >
          <Zap size={13} />
          {automating ? 'Opening…' : 'Automate this pull'}
          <span className="ml-0.5 rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-600">
            beta
          </span>
        </button>
      )}
    </div>
  )
}
