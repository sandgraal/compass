import { ArrowUpRight, Banknote, Globe, HeartPulse, Landmark, ScrollText, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from '../components/ui/Toast'
import { DATA_RIGHTS_SOURCES, type DataRightsDomain } from '../lib/data-rights'

const DOMAIN_ORDER: DataRightsDomain[] = ['Financial', 'Government', 'Health', 'Digital']
const DOMAIN_ICON: Record<DataRightsDomain, JSX.Element> = {
  Financial: <Banknote size={15} />,
  Government: <Landmark size={15} />,
  Health: <HeartPulse size={15} />,
  Digital: <Globe size={15} />
}

export default function DataRights(): JSX.Element {
  const { toast } = useToast()
  const [running, setRunning] = useState<string | null>(null)
  // Adapter ids the main process reports as automatable — empty unless portal
  // automation is enabled (COMPASS_ENABLE_CRED). Drives the "Automate" button's
  // visibility, so an unvalidated/disabled adapter never shows an affordance.
  const [automatable, setAutomatable] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.cred) return
    window.api.cred
      .list()
      .then((list) => setAutomatable(new Set(list.map((a) => a.id))))
      .catch(() => {})
  }, [])

  async function automate(adapterId: string, name: string): Promise<void> {
    if (running) return
    setRunning(adapterId)
    toast(`Opening ${name} — log in when the window appears.`, 'info')
    try {
      const res = await window.api.cred.run(adapterId)
      if (res.ok) {
        const n = res.imported ?? 0
        toast(`Imported ${n} record${n === 1 ? '' : 's'} from ${name}.`, n > 0 ? 'success' : 'info')
      } else if (res.cancelled) {
        toast(`${name} pull cancelled.`, 'info')
      } else {
        toast(res.error || `Couldn't pull from ${name}.`, 'error')
      }
    } catch {
      toast(`Couldn't pull from ${name}.`, 'error')
    } finally {
      setRunning(null)
    }
  }

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
                {sources.map((s) => {
                  const adapterId = s.adapterId
                  return (
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
                      {adapterId && automatable.has(adapterId) && (
                        <button
                          type="button"
                          onClick={() => automate(adapterId, s.name)}
                          disabled={running !== null}
                          title="Compass opens a window, you log in, and it fetches this for you"
                          className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                        >
                          <Zap size={13} />
                          {running === adapterId ? 'Opening…' : 'Automate this pull'}
                          <span className="ml-0.5 rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-600">
                            beta
                          </span>
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      <p className="mt-8 text-xs text-muted-foreground/70">
        Everything stays on your machine — Compass never sends your exports anywhere; it just
        indexes them locally. "Automate this pull" opens the portal's real login in a sandboxed
        window — you log in (and do any 2-factor) yourself; your password is never stored.
      </p>
    </div>
  )
}
