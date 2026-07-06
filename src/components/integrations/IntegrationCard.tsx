import { AlertCircle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { IntegrationMeta } from '../../lib/integration-registry'
import type { CardState } from '../../lib/integration-status'
import { cn, formatRelative } from '../../lib/utils'

const SYNC_INTERVAL_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5, label: 'Every 5m' },
  { value: 15, label: 'Every 15m' },
  { value: 30, label: 'Every 30m' },
  { value: 60, label: 'Every hour' },
  { value: 0, label: 'Manual only' }
]

interface IntegrationCardProps {
  meta: IntegrationMeta
  state: CardState
  lastSyncedAt?: Date | null
  syncIntervalMinutes?: number
  isSyncing: boolean
  onSync: () => void
  onChangeInterval: (minutes: number) => void
  /** Overrides the derived row error (e.g. a failed connect that hasn't
   * written an integrations row yet). Falls back to state.errorMessage. */
  errorMessage?: string | null
  /** Extra actionable node appended under the error banner (e.g. relay link). */
  errorAction?: ReactNode
  /** The connect/config/disconnect body — a setup panel or a bespoke flow. */
  children: ReactNode
}

/**
 * Unified chrome for every integration card: logo + name + status pill, sync
 * controls, description, scopes, a PERSISTENT error banner (replacing the old
 * ephemeral toast), and a body slot. Status is derived upstream by
 * `deriveCardState` so this component stays a dumb renderer.
 */
export default function IntegrationCard({
  meta,
  state,
  lastSyncedAt,
  syncIntervalMinutes,
  isSyncing,
  onSync,
  onChangeInterval,
  errorMessage,
  errorAction,
  children
}: IntegrationCardProps): JSX.Element {
  const { errorWins, isConnected, showNotConnectedGlyph, statusLabel } = state
  const shownError = errorMessage ?? state.errorMessage

  return (
    <div className={cn('bg-gradient-to-br border border-border rounded-xl p-5', meta.color)}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-background/60 flex items-center justify-center text-lg font-bold text-foreground">
            {meta.logo}
          </div>
          <div>
            <h3 className="font-semibold text-foreground">{meta.name}</h3>
            <div className="flex items-center gap-1.5 mt-0.5">
              {!errorWins && isConnected && <CheckCircle2 size={11} className="text-emerald-400" />}
              {errorWins && <AlertCircle size={11} className="text-red-400" />}
              {showNotConnectedGlyph && <XCircle size={11} className="text-muted-foreground/40" />}
              <span
                className={cn(
                  'text-xs',
                  errorWins
                    ? 'text-red-400'
                    : isConnected
                      ? 'text-emerald-400'
                      : 'text-muted-foreground'
                )}
              >
                {statusLabel}
              </span>
            </div>
          </div>
        </div>

        {isConnected && (
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            aria-label={`Sync ${meta.name} now`}
            className="p-1.5 rounded-lg bg-background/40 hover:bg-background/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={cn(isSyncing && 'animate-spin')} />
          </button>
        )}
      </div>

      <p className="text-sm text-muted-foreground mb-3">{meta.description}</p>

      <div className="flex flex-wrap gap-1 mb-4">
        {meta.scopes.map((scope) => (
          <span
            key={scope}
            className="text-xs px-2 py-0.5 bg-background/40 rounded-full text-muted-foreground font-mono"
          >
            {scope}
          </span>
        ))}
      </div>

      {isConnected && lastSyncedAt && (
        <p className="text-xs text-muted-foreground mb-3">
          Last synced {formatRelative(lastSyncedAt)}
        </p>
      )}

      {isConnected && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          <span>Sync</span>
          <select
            value={syncIntervalMinutes ?? 15}
            onChange={(e) => onChangeInterval(Number.parseInt(e.target.value, 10))}
            aria-label={`${meta.name} sync interval`}
            className="bg-background/40 border border-border rounded-md px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
          >
            {SYNC_INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {shownError && (
        <div className="text-xs text-red-400 mb-3 bg-red-500/10 px-2 py-1.5 rounded space-y-1">
          <p>{shownError}</p>
          {errorAction}
        </div>
      )}

      {children}
    </div>
  )
}
