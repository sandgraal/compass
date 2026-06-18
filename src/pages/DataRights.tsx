import { ArrowUpRight, Banknote, Globe, HeartPulse, Landmark, ScrollText } from 'lucide-react'
import { DATA_RIGHTS_SOURCES, type DataRightsDomain } from '../lib/data-rights'

const DOMAIN_ORDER: DataRightsDomain[] = ['Financial', 'Government', 'Health', 'Digital']
const DOMAIN_ICON: Record<DataRightsDomain, JSX.Element> = {
  Financial: <Banknote size={15} />,
  Government: <Landmark size={15} />,
  Health: <HeartPulse size={15} />,
  Digital: <Globe size={15} />
}

export default function DataRights(): JSX.Element {
  return (
    <div className="p-8 pt-14 max-w-3xl mx-auto animate-fade-in">
      <div className="flex items-center gap-2.5 mb-1">
        <ScrollText size={22} className="text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">Get Your Data</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-8 max-w-xl">
        You have a right to most of the data companies and agencies hold about you. Here's where to
        request each one — then drop the export on your{' '}
        <span className="text-foreground">Timeline</span> to keep it forever.
      </p>

      <div className="space-y-8">
        {DOMAIN_ORDER.map((domain) => {
          const sources = DATA_RIGHTS_SOURCES.filter((s) => s.domain === domain)
          if (sources.length === 0) return null
          return (
            <section key={domain}>
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                <span className="text-primary">{DOMAIN_ICON[domain]}</span>
                {domain}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {sources.map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{s.name}</h3>
                      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                        {s.format}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{s.what}</p>
                    <p className="text-xs text-muted-foreground/80">{s.how}</p>
                    <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                      <span className="text-[11px] text-primary/80">↳ {s.intoCompass}</span>
                      {s.url && (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          Request <ArrowUpRight size={13} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <p className="mt-8 text-xs text-muted-foreground/70">
        Everything stays on your machine — Compass never sends your exports anywhere; it just
        indexes them locally.
      </p>
    </div>
  )
}
