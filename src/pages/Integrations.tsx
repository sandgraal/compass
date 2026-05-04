import { useState, useEffect } from 'react'
import { RefreshCw, CheckCircle2, XCircle, Plug2, AlertCircle, ExternalLink } from 'lucide-react'
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
  }
]

const UPCOMING_INTEGRATIONS: IntegrationConfig[] = [
  { id: 'notion', name: 'Notion', description: 'Notes, databases, and project wikis.', scopes: ['read'], color: 'from-slate-500/20 to-slate-700/20', logo: 'N' },
  { id: 'linear', name: 'Linear', description: 'Engineering issues and sprint tracking.', scopes: ['issues:read'], color: 'from-violet-500/20 to-purple-500/20', logo: 'L' },
  { id: 'slack', name: 'Slack', description: 'Action items from DMs and channels.', scopes: ['messages:read'], color: 'from-green-500/20 to-teal-500/20', logo: '#' },
  { id: 'plaid', name: 'Plaid', description: 'Read-only bank & investment balance aggregation.', scopes: ['transactions:read'], color: 'from-blue-500/20 to-indigo-500/20', logo: '$' }
]

export default function Integrations(): JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({})
  const [syncing, setSyncing] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState<string | null>(null)
  const [syncLog, setSyncLog] = useState<Array<{ service: string; time: Date; records: number; error?: string }>>([])

  useEffect(() => {
    loadStatuses()

    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      const unsub = window.api.sync.onSyncUpdate((data) => {
        const d = data as { service: string; status: string; recordsUpdated?: number; error?: string }
        setSyncing(prev => { const next = new Set(prev); next.delete(d.service); return next })
        setSyncLog(prev => [
          { service: d.service, time: new Date(), records: d.recordsUpdated || 0, error: d.error },
          ...prev.slice(0, 9)
        ])
        loadStatuses()
      })
      return unsub
    }
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
    setConnecting(service)
    try {
      const result = service === 'google'
        ? await window.api.auth.connectGoogle()
        : await window.api.auth.connectGitHub()
      if (result.error) {
        alert(`Connection failed: ${result.error}`)
      } else {
        await loadStatuses()
        triggerSync(service)
      }
    } finally {
      setConnecting(null)
    }
  }

  async function disconnect(service: string) {
    if (!confirm(`Disconnect ${service}? Your synced data will remain in the app.`)) return
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      await window.api.auth.disconnect(service)
      await loadStatuses()
    }
  }

  async function triggerSync(service: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    setSyncing(prev => new Set(prev).add(service))
    await window.api.sync.triggerSync(service)
  }

  return (
    <div className="p-8 pt-14 max-w-4xl mx-auto animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect services to automatically populate your knowledge base. Data stays local — only OAuth tokens are stored.
        </p>
      </div>

      {/* Active integrations */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Available</h2>
      <div className="grid grid-cols-2 gap-4 mb-8">
        {INTEGRATIONS.map((integration) => {
          const status = statuses[integration.id]
          const isConnected = status?.status === 'connected'
          const hasError = status?.status === 'error'
          const isSyncing = syncing.has(integration.id)

          return (
            <div key={integration.id} className={cn(
              'bg-gradient-to-br border border-border rounded-xl p-5',
              integration.color
            )}>
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
                      <span className={cn(
                        'text-xs',
                        isConnected ? 'text-emerald-400' :
                        hasError ? 'text-red-400' : 'text-muted-foreground'
                      )}>
                        {isConnected ? 'Connected' : hasError ? 'Error' : 'Not connected'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isConnected && (
                    <button
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
                {integration.scopes.map(scope => (
                  <span key={scope} className="text-xs px-2 py-0.5 bg-background/40 rounded-full text-muted-foreground font-mono">
                    {scope}
                  </span>
                ))}
              </div>

              {isConnected && status?.lastSyncedAt && (
                <p className="text-xs text-muted-foreground mb-3">
                  Last synced {formatRelative(status.lastSyncedAt)}
                </p>
              )}

              {hasError && status?.errorMessage && (
                <p className="text-xs text-red-400 mb-3 bg-red-500/10 px-2 py-1 rounded">
                  {status.errorMessage}
                </p>
              )}

              <div className="flex gap-2">
                {isConnected ? (
                  <button
                    onClick={() => disconnect(integration.id)}
                    className="text-xs px-3 py-1.5 border border-border hover:border-destructive text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
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
      {syncLog.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Sync Log</h2>
          <div className="bg-card border border-border rounded-xl divide-y divide-border">
            {syncLog.map((log, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2">
                  {log.error
                    ? <AlertCircle size={13} className="text-red-400" />
                    : <CheckCircle2 size={13} className="text-emerald-400" />}
                  <span className="text-sm text-foreground capitalize">{log.service}</span>
                  {!log.error && <span className="text-xs text-muted-foreground">{log.records} records updated</span>}
                  {log.error && <span className="text-xs text-red-400">{log.error}</span>}
                </div>
                <span className="text-xs text-muted-foreground">{log.time.toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coming soon */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Coming Soon</h2>
      <div className="grid grid-cols-4 gap-3">
        {UPCOMING_INTEGRATIONS.map(i => (
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
