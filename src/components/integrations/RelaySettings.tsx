import { CheckCircle2, ChevronDown, ChevronRight, Radio, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from '../ui/Toast'

interface RelaySettingsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface RelayConfig {
  relayUrl: string
  isDefault: boolean
  defaultUrl: string
  byoAggregators: string[]
}

interface TestResult {
  ok: boolean
  status?: number
  error?: string
  latencyMs: number
}

/**
 * Relay Settings — self-host URL override + connectivity test for the 7
 * aggregators that route through the Compass relay. The managed default is not
 * currently deployed, so this is how a user points Compass at their own relay
 * (per relay/README) and confirms it's reachable.
 */
export default function RelaySettings({ open, onOpenChange }: RelaySettingsProps): JSX.Element {
  const { toast } = useToast()
  const [config, setConfig] = useState<RelayConfig | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  async function loadConfig(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.relay) return
    try {
      const cfg = await api.relay.getConfig()
      setConfig(cfg)
      setUrlInput(cfg.isDefault ? '' : cfg.relayUrl)
    } catch {
      /* IPC not wired (non-electron); leave null */
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only fetch
  useEffect(() => {
    void loadConfig()
  }, [])

  async function runTest(): Promise<void> {
    const api = window.api
    if (!api?.relay) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.relay.test(urlInput.trim() || undefined)
      setTestResult(r)
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: 0
      })
    } finally {
      setTesting(false)
    }
  }

  async function save(): Promise<void> {
    const api = window.api
    if (!api?.relay) return
    setSaving(true)
    try {
      const r = await api.relay.setUrl(urlInput.trim() || null)
      if (!r.success) {
        toast(r.error ?? 'Could not save the relay URL.', 'error')
        return
      }
      toast(
        r.isDefault ? 'Reset to the managed relay default.' : `Relay URL set to ${r.relayUrl}.`,
        'success'
      )
      await loadConfig()
    } finally {
      setSaving(false)
    }
  }

  const usingSelfHosted = config ? !config.isDefault : false

  return (
    <div className="mb-6 border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="relay-settings-panel"
        className="w-full flex items-center justify-between px-5 py-3.5 bg-card hover:bg-secondary/40 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Relay settings</span>
          <span
            className={
              usingSelfHosted
                ? 'text-xs px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded-full'
                : 'text-xs px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full'
            }
          >
            {usingSelfHosted ? 'Self-hosted' : 'Managed default (not deployed)'}
          </span>
        </div>
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </button>

      {open && (
        <div
          id="relay-settings-panel"
          className="px-5 py-4 border-t border-border bg-card/50 space-y-4 text-sm text-muted-foreground"
        >
          <p className="leading-relaxed">
            Terra, Canopy, Argyle, Arcadia, Metriport, Nylas and Knot connect through the{' '}
            <strong className="text-foreground">Compass relay</strong>, which holds the paid API
            keys server-side. The managed default (
            <code className="bg-secondary px-1 py-0.5 rounded font-mono text-xs">
              {config?.defaultUrl ?? 'https://relay.compass.app'}
            </code>
            ) is <strong className="text-foreground">not currently deployed</strong>, so those
            connections fail until you point Compass at a relay you run yourself.
          </p>

          <div className="space-y-2">
            <label htmlFor="relay-url-input" className="block text-xs text-muted-foreground">
              Relay URL (leave blank to use the managed default)
            </label>
            <input
              id="relay-url-input"
              type="text"
              placeholder="http://localhost:8787"
              aria-label="Relay URL"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => void runTest()}
                disabled={testing}
                className="text-xs px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground rounded transition-colors disabled:opacity-50"
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {testResult && (
                <span
                  className={
                    testResult.ok
                      ? 'inline-flex items-center gap-1 text-xs text-emerald-400'
                      : 'inline-flex items-center gap-1 text-xs text-red-400'
                  }
                >
                  {testResult.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  {testResult.ok
                    ? `Reachable · ${testResult.latencyMs}ms`
                    : `Unreachable — ${testResult.error ?? `HTTP ${testResult.status}`}`}
                </span>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/40 p-3 space-y-1.5">
            <p className="text-xs font-medium text-foreground">Run your own relay</p>
            <p className="text-xs leading-relaxed">
              The relay is a zero-dependency Node service in the{' '}
              <code className="bg-secondary px-1 py-0.5 rounded font-mono">relay/</code> workspace.
              To run it locally:
            </p>
            <pre className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1.5 overflow-x-auto whitespace-pre">
              {`cd relay
npm install
TERRA_DEV_ID=… TERRA_API_KEY=… RELAY_CLIENT_TOKENS=my-device-token npm start
# → [relay] listening on :8787`}
            </pre>
            <p className="text-xs leading-relaxed">
              Then set the Relay URL above to{' '}
              <code className="bg-secondary px-1 py-0.5 rounded font-mono">
                http://localhost:8787
              </code>{' '}
              and click <strong className="text-foreground">Test connection</strong>. Each
              aggregator needs its own upstream keys injected into the relay’s environment. For
              production, deploy it behind TLS (Fly.io, Render, a container, or a serverless
              handler).
            </p>
          </div>

          <p className="text-xs leading-relaxed">
            Prefer not to run a relay? Terra also supports{' '}
            <strong className="text-foreground">bring-your-own keys</strong> (see “Use my own API
            keys” on the Terra card), which calls the upstream directly and bypasses the relay
            entirely.
          </p>
        </div>
      )}
    </div>
  )
}
