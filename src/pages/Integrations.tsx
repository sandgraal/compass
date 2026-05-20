import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plug2,
  RefreshCw,
  XCircle
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn, formatRelative } from '../lib/utils'

interface IntegrationConfig {
  id: string
  name: string
  description: string
  scopes: string[]
  color: string
  logo: string
}

const INTEGRATIONS: IntegrationConfig[] = [
  {
    id: 'google',
    name: 'Google',
    description: 'Calendar events, Gmail action items, and Google Drive file index.',
    scopes: ['calendar.readonly', 'gmail.readonly', 'drive.readonly'],
    color: 'from-red-500/20 to-yellow-500/20',
    logo: 'G'
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues assigned to you, open pull requests, and project board items.',
    scopes: ['repo', 'read:project', 'read:user'],
    color: 'from-gray-500/20 to-gray-700/20',
    logo: '⌥'
  },
  // Apple Calendar uses a local-file integration rather than OAuth: we
  // read directly from ~/Library/Calendars, which means there is no
  // "Connect" round-trip — just toggle sync on. The card uses the same
  // shell but the Connect button immediately triggers a sync.
  {
    id: 'apple-calendar',
    name: 'Apple Calendar',
    description: 'Local-file read of macOS Calendar.app — next 14 days. No OAuth, no network.',
    scopes: ['local:ics'],
    color: 'from-zinc-400/20 to-zinc-600/20',
    logo: ''
  }
]

const SYNC_INTERVAL_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5, label: 'Every 5m' },
  { value: 15, label: 'Every 15m' },
  { value: 30, label: 'Every 30m' },
  { value: 60, label: 'Every hour' },
  { value: 0, label: 'Manual only' }
]

const UPCOMING_INTEGRATIONS: IntegrationConfig[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Notes, databases, and project wikis.',
    scopes: ['read'],
    color: 'from-slate-500/20 to-slate-700/20',
    logo: 'N'
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Engineering issues and sprint tracking.',
    scopes: ['issues:read'],
    color: 'from-violet-500/20 to-purple-500/20',
    logo: 'L'
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Action items from DMs and channels.',
    scopes: ['messages:read'],
    color: 'from-green-500/20 to-teal-500/20',
    logo: '#'
  },
  {
    id: 'plaid',
    name: 'Plaid',
    description: 'Read-only bank & investment balance aggregation.',
    scopes: ['transactions:read'],
    color: 'from-blue-500/20 to-indigo-500/20',
    logo: '$'
  }
]

export default function Integrations(): JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({})
  const [syncing, setSyncing] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState<string | null>(null)
  const [syncLog, setSyncLog] = useState<
    Array<{ service: string; time: Date; records: number; error?: string }>
  >([])
  const [setupOpen, setSetupOpen] = useState(false)
  const [redirectUris, setRedirectUris] = useState<{ google: string; github: string } | null>(null)
  // Null = the inline PAT form is collapsed. String = it's open, with the
  // current input value. Single-instance because the only PAT-connectable
  // integration today is GitHub (Google's still OAuth).
  const [githubPatInput, setGithubPatInput] = useState<string | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    loadStatuses()

    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return undefined

    window.api.auth
      .getRedirectUris()
      .then((uris: RedirectUris) => {
        setRedirectUris(uris)
      })
      .catch(() => {
        /* use fallback */
      })

    // Load persisted sync log from DB on mount
    window.api.sync
      .getLog()
      .then((rows) => {
        setSyncLog(
          rows.map((r) => ({
            service: r.service,
            time: new Date(r.syncedAt),
            records: r.recordsUpdated,
            error: r.error ?? undefined
          }))
        )
      })
      .catch(() => {
        /* no log yet */
      })

    const unsub = window.api.sync.onSyncUpdate((data) => {
      const d = data as { service: string; status: string; recordsUpdated?: number; error?: string }
      setSyncing((prev) => {
        const next = new Set(prev)
        next.delete(d.service)
        return next
      })
      setSyncLog((prev) => [
        { service: d.service, time: new Date(), records: d.recordsUpdated || 0, error: d.error },
        ...prev.slice(0, 19)
      ])
      loadStatuses()
    })
    return unsub
  }, [])

  async function loadStatuses() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const rows = await window.api.sync.getSyncStatus()
      const map: Record<string, IntegrationStatus> = {}
      for (const r of rows) map[r.service] = r
      setStatuses(map)
    }
  }

  async function connect(service: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    // GitHub now uses Personal Access Tokens by default — much friendlier
    // than walking a non-developer through registering an OAuth App. Open
    // the inline PAT form instead of starting the OAuth dance.
    if (service === 'github') {
      setGithubPatInput('')
      return
    }
    setConnecting(service)
    try {
      // Apple Calendar is local-file based — no OAuth, just kick off a
      // sync which will create the integration row on first success.
      if (service === 'apple-calendar') {
        const r = await window.api.sync.triggerSync(service)
        if (r && 'error' in r && r.error) {
          toast(`Sync failed: ${r.error}`, 'error')
        }
        await loadStatuses()
        return
      }
      const result = await window.api.auth.connectGoogle()
      if (result.error) {
        toast(`Connection failed: ${result.error}`, 'error')
      } else {
        await loadStatuses()
        triggerSync(service)
      }
    } finally {
      setConnecting(null)
    }
  }

  async function submitGitHubPat() {
    if (typeof githubPatInput !== 'string') return
    const trimmed = githubPatInput.trim()
    if (!trimmed) {
      toast('Paste a Personal Access Token first.', 'error')
      return
    }
    setConnecting('github')
    try {
      const r = await window.api.auth.connectGitHubWithPAT(trimmed)
      if (r.error) {
        toast(`Connection failed: ${r.error}`, 'error')
        return
      }
      toast(`Connected as @${r.login ?? 'github user'}`, 'success')
      setGithubPatInput(null)
      await loadStatuses()
      triggerSync('github')
    } finally {
      setConnecting(null)
    }
  }

  async function disconnect(service: string) {
    const ok = await confirm({
      title: `Disconnect ${service}?`,
      description: 'Your synced data will remain in the app. You can reconnect at any time.',
      confirmLabel: 'Disconnect',
      destructive: false
    })
    if (!ok) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      await window.api.auth.disconnect(service)
      await loadStatuses()
    }
  }

  async function triggerSync(service: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    setSyncing((prev) => new Set(prev).add(service))
    await window.api.sync.triggerSync(service)
  }

  async function changeSyncInterval(service: string, minutes: number) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    // Optimistic update so the dropdown reflects the change immediately.
    setStatuses((prev) => {
      const existing = prev[service]
      if (!existing) return prev
      return { ...prev, [service]: { ...existing, syncIntervalMinutes: minutes } }
    })
    await window.api.sync.setInterval(service, minutes)
    await loadStatuses()
  }

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect services to automatically populate your knowledge base. Data stays local — only
          OAuth tokens are stored.
        </p>
      </div>

      {/* Setup guide */}
      <div className="mb-6 border border-border rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setSetupOpen((v) => !v)}
          aria-expanded={setupOpen}
          aria-controls="setup-guide-panel"
          className="w-full flex items-center justify-between px-5 py-3.5 bg-card hover:bg-secondary/40 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Setup Guide — OAuth Credentials
            </span>
            <span className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full">
              Required before connecting
            </span>
          </div>
          {setupOpen ? (
            <ChevronDown size={14} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="text-muted-foreground" />
          )}
        </button>

        {setupOpen && (
          <div
            id="setup-guide-panel"
            className="px-5 py-4 border-t border-border bg-card/50 space-y-5 text-sm text-muted-foreground"
          >
            <p>
              <strong className="text-foreground">Google</strong> uses OAuth, which means
              registering your own OAuth app once (steps below). Credentials live in your local{' '}
              <code className="text-xs bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code> and
              never leave your machine.
            </p>
            <p>
              <strong className="text-foreground">GitHub</strong> uses a Personal Access Token —
              just click <strong className="text-foreground">Connect</strong> on the card above and
              paste a token. No OAuth app, no callback URL, no{' '}
              <code className="text-xs bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code>{' '}
              edits.
            </p>

            {/* Google */}
            <div>
              <h3 className="text-foreground font-semibold mb-2">
                Google (Calendar · Gmail · Drive)
              </h3>
              <ol className="list-decimal list-inside space-y-1.5 text-xs leading-relaxed">
                <li>
                  Open{' '}
                  <a
                    href="https://console.cloud.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    console.cloud.google.com
                  </a>{' '}
                  and create a new project (or use an existing one).
                </li>
                <li>
                  Go to{' '}
                  <strong className="text-foreground">
                    APIs &amp; Services → OAuth consent screen
                  </strong>
                  . Choose <em>External</em>, fill in the app name ("Compass"), your email, and
                  save.
                </li>
                <li>
                  Go to{' '}
                  <strong className="text-foreground">
                    APIs &amp; Services → Credentials → Create Credentials → OAuth client ID
                  </strong>
                  .
                </li>
                <li>
                  Choose <strong className="text-foreground">Web application</strong> (not Desktop —
                  the HTTP redirect requires this).
                </li>
                <li>
                  Add{' '}
                  {redirectUris ? (
                    <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">
                      {redirectUris.google}
                    </code>
                  ) : (
                    <em>loading…</em>
                  )}{' '}
                  as an <strong className="text-foreground">Authorized redirect URI</strong>.
                </li>
                <li>
                  Copy the <strong className="text-foreground">Client ID</strong> and{' '}
                  <strong className="text-foreground">Client secret</strong> into your{' '}
                  <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code> file.
                </li>
                <li>
                  Enable the required APIs:{' '}
                  <strong className="text-foreground">Google Calendar API</strong>,{' '}
                  <strong className="text-foreground">Gmail API</strong>, and{' '}
                  <strong className="text-foreground">Google Drive API</strong> under{' '}
                  <em>APIs &amp; Services → Library</em>.
                </li>
                <li>
                  While in test mode, add your Google account under{' '}
                  <strong className="text-foreground">OAuth consent screen → Test users</strong>.
                </li>
              </ol>
            </div>

            {/* GitHub */}
            <div>
              <h3 className="text-foreground font-semibold mb-2">
                GitHub (Issues · PRs · Projects)
              </h3>
              <p className="text-xs leading-relaxed mb-2">
                GitHub uses a Personal Access Token — no OAuth App registration, no{' '}
                <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code> edits.
                Click <strong className="text-foreground">Connect</strong> on the card above to
                start; Compass walks you through the rest. Under the hood the click takes you to:
              </p>
              <ol className="list-decimal list-inside space-y-1.5 text-xs leading-relaxed">
                <li>
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo,read:project,read:user&description=Compass"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    github.com/settings/tokens/new
                  </a>{' '}
                  with the right scopes pre-selected (
                  <code className="bg-secondary px-1 py-0.5 rounded font-mono">repo</code>,{' '}
                  <code className="bg-secondary px-1 py-0.5 rounded font-mono">read:project</code>,{' '}
                  <code className="bg-secondary px-1 py-0.5 rounded font-mono">read:user</code>).
                </li>
                <li>
                  Click <strong className="text-foreground">Generate token</strong> at the bottom —
                  optionally tighten the expiration window.
                </li>
                <li>
                  Copy the token (starts with{' '}
                  <code className="bg-secondary px-1 py-0.5 rounded font-mono">ghp_</code> or{' '}
                  <code className="bg-secondary px-1 py-0.5 rounded font-mono">github_pat_</code>)
                  and paste it into Compass. The token is encrypted with the OS Keychain and never
                  leaves your machine.
                </li>
              </ol>
            </div>

            {/* .env location */}
            <div className="bg-secondary/50 rounded-lg px-4 py-3 font-mono text-xs space-y-1">
              <p className="text-foreground font-semibold text-xs mb-2 font-sans">
                .env (in project root) — Google only
              </p>
              <p>
                GOOGLE_CLIENT_ID=<span className="text-amber-400">your_client_id</span>
              </p>
              <p>
                GOOGLE_CLIENT_SECRET=<span className="text-amber-400">your_client_secret</span>
              </p>
            </div>

            <p className="text-xs">
              After editing{' '}
              <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code>, restart
              the app (
              <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">npm run dev</code>) for
              the credentials to take effect.
            </p>
          </div>
        )}
      </div>

      {/* Active integrations */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Available
      </h2>
      <div className="grid grid-cols-2 gap-4 mb-8">
        {INTEGRATIONS.map((integration) => {
          const status = statuses[integration.id]
          const isConnected = status?.status === 'connected'
          const hasError = status?.status === 'error'
          const isSyncing = syncing.has(integration.id)

          return (
            <div
              key={integration.id}
              className={cn(
                'bg-gradient-to-br border border-border rounded-xl p-5',
                integration.color
              )}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-background/60 flex items-center justify-center text-lg font-bold text-foreground">
                    {integration.logo}
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{integration.name}</h3>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {isConnected && <CheckCircle2 size={11} className="text-emerald-400" />}
                      {hasError && <AlertCircle size={11} className="text-red-400" />}
                      {!status && <XCircle size={11} className="text-muted-foreground/40" />}
                      <span
                        className={cn(
                          'text-xs',
                          isConnected
                            ? 'text-emerald-400'
                            : hasError
                              ? 'text-red-400'
                              : 'text-muted-foreground'
                        )}
                      >
                        {isConnected ? 'Connected' : hasError ? 'Error' : 'Not connected'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isConnected && (
                    <button
                      type="button"
                      onClick={() => triggerSync(integration.id)}
                      disabled={isSyncing}
                      className="p-1.5 rounded-lg bg-background/40 hover:bg-background/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={cn(isSyncing && 'animate-spin')} />
                    </button>
                  )}
                </div>
              </div>

              <p className="text-sm text-muted-foreground mb-3">{integration.description}</p>

              <div className="flex flex-wrap gap-1 mb-4">
                {integration.scopes.map((scope) => (
                  <span
                    key={scope}
                    className="text-xs px-2 py-0.5 bg-background/40 rounded-full text-muted-foreground font-mono"
                  >
                    {scope}
                  </span>
                ))}
              </div>

              {isConnected && status?.lastSyncedAt && (
                <p className="text-xs text-muted-foreground mb-3">
                  Last synced {formatRelative(status.lastSyncedAt)}
                </p>
              )}

              {isConnected && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                  <span>Sync</span>
                  <select
                    value={status?.syncIntervalMinutes ?? 15}
                    onChange={(e) =>
                      changeSyncInterval(integration.id, Number.parseInt(e.target.value, 10))
                    }
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

              {hasError && status?.errorMessage && (
                <p className="text-xs text-red-400 mb-3 bg-red-500/10 px-2 py-1 rounded">
                  {status.errorMessage}
                </p>
              )}

              {/* Inline PAT form — only for GitHub, only when the user has
                  clicked Connect. Replaces the OAuth-App dance with a 3-click
                  flow: open the GitHub tokens page, generate, paste back. */}
              {integration.id === 'github' && !isConnected && githubPatInput !== null && (
                <div className="mb-3 p-3 bg-background/40 border border-border rounded-lg space-y-2">
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    Paste a GitHub Personal Access Token. Compass stores it encrypted on disk — no
                    OAuth App needed.{' '}
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo,read:project,read:user&description=Compass"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
                    >
                      Open GitHub
                      <ExternalLink size={10} className="opacity-70" />
                    </a>{' '}
                    (the scopes are pre-selected; just click <em>Generate</em>).
                  </div>
                  <label htmlFor="github-pat-input" className="block text-xs text-muted-foreground">
                    GitHub Personal Access Token
                  </label>
                  <input
                    id="github-pat-input"
                    type="password"
                    placeholder="ghp_… or github_pat_…"
                    value={githubPatInput}
                    onChange={(e) => setGithubPatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitGitHubPat()
                      else if (e.key === 'Escape') setGithubPatInput(null)
                    }}
                    className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void submitGitHubPat()}
                      disabled={connecting === 'github' || !githubPatInput.trim()}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                    >
                      <Plug2 size={11} />
                      {connecting === 'github' ? 'Connecting…' : 'Connect'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setGithubPatInput(null)}
                      className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                {isConnected ? (
                  <button
                    type="button"
                    onClick={() => disconnect(integration.id)}
                    className="text-xs px-3 py-1.5 border border-border hover:border-destructive text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                  >
                    Disconnect
                  </button>
                ) : integration.id === 'github' && githubPatInput !== null ? null : (
                  <button
                    type="button"
                    onClick={() => connect(integration.id)}
                    disabled={connecting === integration.id}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Plug2 size={11} />
                    {connecting === integration.id ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Sync log */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Sync Log
        </h2>
        <div className="bg-card border border-border rounded-xl divide-y divide-border">
          {syncLog.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No sync history yet. Connect an integration and trigger a sync.
            </div>
          ) : (
            syncLog.slice(0, 10).map((log) => {
              const isToday = log.time.toDateString() === new Date().toDateString()
              const timeStr = isToday
                ? log.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : `${log.time.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${log.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              const logKey = `${log.service}-${log.time.getTime()}-${log.error ?? log.records}`
              return (
                <div key={logKey} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    {log.error ? (
                      <AlertCircle size={13} className="text-red-400 shrink-0" />
                    ) : (
                      <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                    )}
                    <span className="text-sm text-foreground capitalize shrink-0">
                      {log.service}
                    </span>
                    {!log.error && (
                      <span className="text-xs text-muted-foreground">
                        {log.records} records updated
                      </span>
                    )}
                    {log.error && (
                      <span className="text-xs text-red-400 truncate">{log.error}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">{timeStr}</span>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Coming soon */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Coming Soon
      </h2>
      <div className="grid grid-cols-4 gap-3">
        {UPCOMING_INTEGRATIONS.map((i) => (
          <div key={i.id} className="bg-card border border-border rounded-xl p-4 opacity-60">
            <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-sm font-bold text-foreground mb-2">
              {i.logo}
            </div>
            <p className="text-sm font-medium text-foreground">{i.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{i.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
