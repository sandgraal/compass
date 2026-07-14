/**
 * Web presence card — renders the accepted web-enrichment findings persisted
 * at `places.meta.enrichment.web` (see electron/ipc/place-web-enrich.ts).
 * Shared by PlaceDetail and MerchantDetail; read-only (a re-run of the
 * enrichment dialog replaces the whole namespace).
 */
import { ExternalLink } from 'lucide-react'
import { WEB_ENRICH_STALE_MONTHS, cn, monthsSince } from '../../lib/utils'

const safeHref = (value: string): string | undefined =>
  /^https?:\/\//i.test(value) ? value : undefined

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function WebPresenceCard({
  web,
  onRefresh
}: {
  web: PlaceWebEnrichment
  /** Re-opens the enrichment dialog (a re-run replaces the whole namespace). */
  onRefresh?: () => void
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 space-y-2">
      {web.description && <p className="text-sm text-foreground">{web.description}</p>}
      {(web.phone || web.hours) && (
        <div className="space-y-1 text-sm">
          {web.phone && (
            <p>
              <span className="text-xs text-muted-foreground w-14 inline-block">Phone</span>
              <span className="text-foreground">{web.phone}</span>
            </p>
          )}
          {web.hours && (
            <p>
              <span className="text-xs text-muted-foreground w-14 inline-block">Hours</span>
              <span className="text-foreground">{web.hours}</span>
            </p>
          )}
        </div>
      )}
      {web.links.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {web.links.map((l) => {
            const href = safeHref(l.value)
            if (!href) return null
            return (
              <a
                key={l.value}
                href={href}
                target="_blank"
                rel="noreferrer"
                title={href}
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-border text-primary hover:bg-primary/10 transition-colors"
              >
                <ExternalLink size={10} />
                {l.type || hostOf(l.value)}
              </a>
            )
          })}
        </div>
      )}
      {web.facts.length > 0 && (
        <ul className="space-y-0.5">
          {web.facts.map((f) => (
            <li key={f.text} className="text-xs text-muted-foreground">
              • {f.text}
            </li>
          ))}
        </ul>
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
