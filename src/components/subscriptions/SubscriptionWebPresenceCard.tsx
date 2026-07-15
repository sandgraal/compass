/**
 * Web presence card for subscriptions — renders the accepted web-enrichment
 * findings persisted at `subscriptions.meta.enrichment.web` (see
 * electron/ipc/subscription-web-enrich.ts). Read-only; a re-run of the
 * enrichment dialog replaces the whole namespace. The subscription-flavored
 * sibling of places/WebPresenceCard.tsx.
 */
import { ExternalLink } from 'lucide-react'
import { WEB_ENRICH_STALE_MONTHS, cn, monthsSince } from '../../lib/utils'

const safeHref = (value: string): string | undefined =>
  /^https?:\/\//i.test(value) ? value : undefined

export default function SubscriptionWebPresenceCard({
  web,
  onRefresh
}: {
  web: SubscriptionWebEnrichment
  /** Re-opens the enrichment dialog (a re-run replaces the whole namespace). */
  onRefresh?: () => void
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 space-y-3">
      {(web.pricingSummary || web.annualDiscount || web.plans.length > 0) && (
        <div className="space-y-1">
          {web.pricingSummary && <p className="text-sm text-foreground">{web.pricingSummary}</p>}
          {web.annualDiscount && <p className="text-xs text-primary">{web.annualDiscount}</p>}
          {web.plans.length > 0 && (
            <ul className="space-y-0.5 mt-1">
              {web.plans.map((p) => (
                <li key={p.name} className="text-xs text-muted-foreground">
                  <span className="text-foreground font-medium">{p.name}</span> — {p.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {web.benefits.length > 0 && (
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
            What you get
          </p>
          <ul className="space-y-0.5">
            {web.benefits.map((b) => (
              <li key={b.text} className="text-xs text-muted-foreground">
                • {b.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(web.cancellationSteps || web.cancellationUrl) && (
        <div className="rounded-md border border-border bg-secondary/30 px-2.5 py-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
            How to cancel
          </p>
          {web.cancellationSteps && (
            <p className="text-xs text-foreground whitespace-pre-wrap">{web.cancellationSteps}</p>
          )}
          {web.cancellationUrl && safeHref(web.cancellationUrl) && (
            <a
              href={safeHref(web.cancellationUrl)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
            >
              <ExternalLink size={11} /> Cancel page
            </a>
          )}
        </div>
      )}

      {web.alternatives.length > 0 && (
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
            Alternatives worth considering
          </p>
          <ul className="space-y-0.5">
            {web.alternatives.map((a) => (
              <li key={a.name} className="text-xs text-muted-foreground">
                <span className="text-foreground font-medium">{a.name}</span> — {a.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {web.supportUrl && safeHref(web.supportUrl) && (
        <a
          href={safeHref(web.supportUrl)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border text-primary hover:bg-primary/10 transition-colors"
        >
          <ExternalLink size={10} /> Support
        </a>
      )}

      <div className="flex items-center justify-between gap-2 pt-0.5 border-t border-border">
        <p
          className={cn(
            'text-[11px]',
            monthsSince(web.refreshedAt) >= WEB_ENRICH_STALE_MONTHS
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground'
          )}
        >
          Searched as “{web.searchedAs}” ·{' '}
          {monthsSince(web.refreshedAt) >= WEB_ENRICH_STALE_MONTHS
            ? `${monthsSince(web.refreshedAt)} months ago — worth a refresh`
            : new Date(web.refreshedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}{' '}
          · {web.sources.length} source{web.sources.length === 1 ? '' : 's'}
        </p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="shrink-0 text-[11px] text-primary hover:underline"
          >
            Re-run
          </button>
        )}
      </div>
    </div>
  )
}
