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
  },
  // Obsidian is local-file based like Apple Calendar — no OAuth. The user
  // points Compass at a vault folder; sync runs two one-way mirrors
  // (vault → knowledge-base/obsidian, knowledge-base → vault/Compass).
  {
    id: 'obsidian',
    name: 'Obsidian',
    description:
      'Two-way markdown bridge with a local vault — vault notes appear in your knowledge base, Compass notes appear in the vault. No cloud.',
    scopes: ['local:markdown'],
    color: 'from-purple-500/20 to-violet-600/20',
    logo: '◆'
  },
  // Notion uses an internal-integration token (paste-once, like the GitHub
  // PAT) — only pages the user explicitly shares with the integration are
  // visible to the API. Import lands under knowledge-base/notion/.
  {
    id: 'notion',
    name: 'Notion',
    description:
      'Imports pages you share with your Notion integration into the knowledge base as markdown.',
    scopes: ['pages:read'],
    color: 'from-slate-500/20 to-slate-700/20',
    logo: 'N'
  },
  {
    id: 'plaid',
    name: 'Plaid',
    description: 'Bank balances + transactions via Plaid Link. Tokens encrypted on disk.',
    scopes: ['transactions:read', 'accounts:read'],
    color: 'from-blue-500/20 to-indigo-500/20',
    logo: '$'
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
  // integration today is GitHub.
  const [githubPatInput, setGithubPatInput] = useState<string | null>(null)
  // Null = Google credentials form is collapsed. Object = form is open
  // with the current Client ID + Secret values. Stays open until either
  // (a) the user successfully submits, or (b) they click Cancel.
  const [googleCredsInput, setGoogleCredsInput] = useState<{
    clientId: string
    clientSecret: string
  } | null>(null)
  const [googleCredsConfigured, setGoogleCredsConfigured] = useState(false)
  // Plaid state. `status` mirrors `window.api.plaid.getStatus()` (SDK config
  // + per-env secret presence); `items` is the list of connected Items
  // (renders each as a sub-row inside the Plaid card). Null = not yet
  // loaded; we render a loading placeholder for one tick.
  const [plaidStatus, setPlaidStatus] = useState<{
    configured: boolean
    env: 'sandbox' | 'production' | null
    hasSecret: boolean
  } | null>(null)
  const [plaidItems, setPlaidItems] = useState<
    Array<{
      id: number
      itemId: string
      institutionId: string
      institutionName: string
      lastSyncedAt: number | null
      errorCode: string | null
    }>
  >([])
  // Inline "set secret" form for Plaid. Mirrors the GitHub PAT / Google
  // credentials pattern from earlier PRs.
  const [plaidSecretInput, setPlaidSecretInput] = useState<string | null>(null)
  // Obsidian vault bridge. Status mirrors `window.api.obsidian.getStatus()`;
  // the path input follows the same convention as the PAT / Plaid-secret
  // forms above: null = form collapsed, string = form open with that value.
  const [obsidianStatus, setObsidianStatus] = useState<{
    configured: boolean
    vaultPath: string | null
    looksLikeVault: boolean
    error: string | null
  } | null>(null)
  const [obsidianPathInput, setObsidianPathInput] = useState<string | null>(null)
  // Notion internal-integration token form. Same convention as the GitHub
  // PAT input above: null = form collapsed, string = form open.
  const [notionTokenInput, setNotionTokenInput] = useState<string | null>(null)
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

    window.api.auth
      .hasGoogleCredentials()
      .then(({ configured }) => {
        setGoogleCredsConfigured(configured)
      })
      .catch(() => {
        /* leave at default false */
      })

    void loadPlaid()
    void loadObsidian()

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
      // Plaid card needs an extra refresh because lastSyncedAt + errorCode
      // live on the per-Item rows (plaid_items), not on `integrations`.
      // Without this, the "Last synced" timestamp on each bank wouldn't
      // update until the user navigated away and back.
      if (d.service === 'plaid') void loadPlaid()
      if (d.service === 'obsidian') void loadObsidian()
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
    // Google: if credentials aren't stored yet, open the credentials form
    // first. Once stored, subsequent Connect clicks proceed to the OAuth
    // dance directly.
    if (service === 'google' && !googleCredsConfigured) {
      setGoogleCredsInput({ clientId: '', clientSecret: '' })
      return
    }
    // Plaid:
    //   - Status not yet loaded → kick off the load + bail. Without this
    //     guard, an early click reads `plaidStatus?.configured` as
    //     undefined and falsely toasts "SDK not configured".
    //   - SDK not configured (~/.config/compass/plaid.env missing) → noop
    //     with a toast pointing at docs; the file is currently dev-only,
    //     a UI for it is a future PR (parallel to the Google credentials work).
    //   - Secret missing → open the inline secret form.
    //   - Otherwise → start Plaid Link (the child window flow from PR 3).
    if (service === 'plaid') {
      if (plaidStatus === null) {
        toast('Loading Plaid status — try again in a moment.', 'info')
        void loadPlaid()
        return
      }
      if (!plaidStatus.configured) {
        toast('Plaid SDK not configured. See docs/finance/plaid-integration.md.', 'error')
        return
      }
      if (!plaidStatus.hasSecret) {
        setPlaidSecretInput('')
        return
      }
      void connectPlaidBank()
      return
    }
    // Obsidian: no OAuth — Connect opens the vault-path form; once a vault
    // is configured the card's refresh icon (or cron) handles syncing.
    if (service === 'obsidian') {
      setObsidianPathInput(obsidianStatus?.vaultPath ?? '')
      return
    }
    // Notion: paste-once internal-integration token, like the GitHub PAT.
    if (service === 'notion') {
      setNotionTokenInput('')
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

  // Refresh Plaid status + items list. Called on mount, after any Plaid
  // action (set-secret, start-link, disconnect, sync), and after any sync
  // event. Cheap: two small IPC round-trips against in-process DB.
  async function loadPlaid(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.plaid) return
    try {
      const [status, items] = await Promise.all([api.plaid.getStatus(), api.plaid.listItems()])
      setPlaidStatus({
        configured: status.configured,
        env: status.env,
        hasSecret: status.hasSecret
      })
      setPlaidItems(items)
    } catch {
      /* IPC may not be wired in non-electron contexts (Storybook etc.); ignore */
    }
  }

  // Refresh Obsidian bridge status. Called on mount, after configure /
  // disconnect, and after every obsidian sync event.
  async function loadObsidian(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.obsidian) return
    try {
      setObsidianStatus(await api.obsidian.getStatus())
    } catch {
      /* IPC may not be wired in non-electron contexts; ignore */
    }
  }

  async function submitObsidianPath() {
    if (typeof obsidianPathInput !== 'string') return
    const path = obsidianPathInput.trim()
    if (!path) {
      toast('Enter the path to your Obsidian vault first.', 'error')
      return
    }
    setConnecting('obsidian')
    try {
      const r = await window.api.obsidian.setVaultPath(path)
      if (!r.success) {
        toast(r.error ?? 'Could not use that folder.', 'error')
        return
      }
      if (r.looksLikeVault === false) {
        toast(
          'Connected — note: no .obsidian folder found, treating it as a plain notes folder.',
          'info'
        )
      } else {
        toast('Obsidian vault connected.', 'success')
      }
      setObsidianPathInput(null)
      await loadObsidian()
      await loadStatuses()
      triggerSync('obsidian')
    } catch (err) {
      toast(
        `Couldn't save vault path: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    } finally {
      setConnecting(null)
    }
  }

  async function submitNotionToken() {
    if (typeof notionTokenInput !== 'string') return
    const token = notionTokenInput.trim()
    if (!token) {
      toast('Paste your Notion integration token first.', 'error')
      return
    }
    setConnecting('notion')
    try {
      const r = await window.api.auth.connectNotion(token)
      if (r.error) {
        toast(`Connection failed: ${r.error}`, 'error')
        return
      }
      toast(r.workspace ? `Connected to ${r.workspace}.` : 'Notion connected.', 'success')
      setNotionTokenInput(null)
      await loadStatuses()
      triggerSync('notion')
    } catch (err) {
      toast(`Couldn't connect: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setConnecting(null)
    }
  }

  async function submitPlaidSecret() {
    if (typeof plaidSecretInput !== 'string') return
    const secret = plaidSecretInput.trim()
    if (!secret) {
      toast('Paste your Plaid secret first.', 'error')
      return
    }
    if (!plaidStatus?.env) {
      toast('Plaid env not configured (~/.config/compass/plaid.env missing).', 'error')
      return
    }
    setConnecting('plaid')
    try {
      await window.api.plaid.setSecret(plaidStatus.env, secret)
      toast('Plaid secret saved.', 'success')
      setPlaidSecretInput(null)
      await loadPlaid()
    } catch (err) {
      toast(`Couldn't save secret: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setConnecting(null)
    }
  }

  async function connectPlaidBank() {
    setConnecting('plaid')
    try {
      const r = await window.api.plaid.startLink()
      if (r.ok) {
        toast(`Connected ${r.result.institutionName ?? 'institution'}.`, 'success')
        await loadPlaid()
        await loadStatuses()
        triggerSync('plaid')
      } else if (r.cancelled) {
        // User backed out — silent, this is a state not an error.
      } else {
        toast(`Plaid Link failed: ${r.errorMessage ?? r.errorCode ?? 'unknown'}`, 'error')
      }
    } catch (err) {
      // The IPC promise itself rejected — handler crashed, contextBridge
      // threw, etc. Surface as a toast so the user isn't left staring at
      // a stopped spinner with no explanation.
      toast(`Plaid Link error: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setConnecting(null)
    }
  }

  async function disconnectPlaidItem(itemId: string, institutionName: string) {
    const ok = await confirm({
      title: `Disconnect ${institutionName}?`,
      description:
        'Plaid will stop syncing this institution. Existing transactions stay in Compass. You can reconnect later.',
      confirmLabel: 'Disconnect',
      destructive: false
    })
    if (!ok) return
    await window.api.plaid.disconnect(itemId)
    toast(`Disconnected ${institutionName}.`, 'success')
    await loadPlaid()
  }

  // Clear stored Google credentials and reopen the inline form. Used for
  // rotating a leaked secret or correcting a typo without disconnecting +
  // reconnecting the OAuth tokens themselves.
  async function editGoogleCredentials() {
    const ok = await confirm({
      title: 'Replace stored Google credentials?',
      description:
        'The current Client ID + Secret will be cleared so you can paste new ones. Your OAuth tokens stay until you Disconnect.',
      confirmLabel: 'Replace',
      destructive: false
    })
    if (!ok) return
    await window.api.auth.clearGoogleCredentials()
    setGoogleCredsConfigured(false)
    setGoogleCredsInput({ clientId: '', clientSecret: '' })
  }

  // Save Google credentials, then immediately kick off the OAuth dance so
  // the user sees a single "Connect" action rather than two-step ceremony.
  async function submitGoogleCredentials() {
    if (!googleCredsInput) return
    const id = googleCredsInput.clientId.trim()
    const secret = googleCredsInput.clientSecret.trim()
    if (!id || !secret) {
      toast('Both Client ID and Client Secret are required.', 'error')
      return
    }
    setConnecting('google')
    try {
      const save = await window.api.auth.setGoogleCredentials(id, secret)
      if (save.error) {
        toast(save.error, 'error')
        return
      }
      setGoogleCredsConfigured(true)
      setGoogleCredsInput(null)
      // Immediately start the OAuth flow with the just-stored creds.
      const oauth = await window.api.auth.connectGoogle()
      if (oauth.error) {
        toast(`OAuth failed: ${oauth.error}`, 'error')
        return
      }
      toast('Connected to Google.', 'success')
      await loadStatuses()
      triggerSync('google')
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
      // Obsidian has no OAuth token — disconnect = forget the vault path.
      // Files already mirrored (both directions) stay where they are.
      if (service === 'obsidian') {
        await window.api.obsidian.clear()
        await loadObsidian()
      } else {
        await window.api.auth.disconnect(service)
      }
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
              <strong className="text-foreground">Google</strong> uses OAuth — register your own
              OAuth app once (steps below), then paste the Client ID + Secret into the inline form
              when you click <strong className="text-foreground">Connect</strong>. The credentials
              are encrypted via OS Keychain; no file editing required.
            </p>
            <p>
              <strong className="text-foreground">GitHub</strong> uses a Personal Access Token —
              just click <strong className="text-foreground">Connect</strong> on the card and paste
              a token. No OAuth app, no callback URL.
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
                <li>
                  Click <strong className="text-foreground">Connect</strong> on the Google card
                  above and paste your <strong className="text-foreground">Client ID</strong> +{' '}
                  <strong className="text-foreground">Client secret</strong>. Compass encrypts them
                  via the OS Keychain — no{' '}
                  <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code>{' '}
                  editing.
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

            <p className="text-xs">
              Dev workflows can still set{' '}
              <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">GOOGLE_CLIENT_ID</code>{' '}
              +{' '}
              <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">
                GOOGLE_CLIENT_SECRET
              </code>{' '}
              in a <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">.env</code> file
              at the repo root — they're read as a fallback when no in-app credentials are stored.
              Packaged-app users should use the inline form instead.
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
          const baseIsConnected = status?.status === 'connected'
          const baseHasError = status?.status === 'error'
          // Plaid's "connected" + "error" come from the per-Item state, not
          // from the singleton `integrations` row — there can be 0 or many
          // Items, and one bad Item shouldn't poison the whole card.
          const isConnected = integration.id === 'plaid' ? plaidItems.length > 0 : baseIsConnected
          const hasError =
            integration.id === 'plaid' ? plaidItems.some((i) => i.errorCode) : baseHasError
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
                      {/* Plaid is multi-Item: an Item can need re-auth while
                          others are healthy. When that's the case, surface
                          the error state at the card level (a single bad
                          institution shouldn't read as a quiet green
                          "Connected"). For non-Plaid integrations the
                          original isConnected-wins logic is unchanged. */}
                      {(() => {
                        const errorWins = hasError && (integration.id === 'plaid' || !isConnected)
                        return (
                          <>
                            {!errorWins && isConnected && (
                              <CheckCircle2 size={11} className="text-emerald-400" />
                            )}
                            {errorWins && <AlertCircle size={11} className="text-red-400" />}
                            {!status && integration.id !== 'plaid' && (
                              <XCircle size={11} className="text-muted-foreground/40" />
                            )}
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
                              {errorWins
                                ? integration.id === 'plaid' && isConnected
                                  ? 'Needs attention'
                                  : 'Error'
                                : isConnected
                                  ? 'Connected'
                                  : 'Not connected'}
                            </span>
                          </>
                        )
                      })()}
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

              {/* ─── Plaid card body ───────────────────────────────────────
                  Custom subsection that renders inside the standard card
                  shell. Two states:
                    1. No secret stored → inline secret form (sandbox vs
                       production picked up from the SDK config).
                    2. Has secret → list of connected Items as sub-rows
                       with last-synced timestamp, error CTA if applicable,
                       and a "Connect new bank" anchor.
                  Both branches assume the Plaid SDK is configured — the
                  outer Connect button noop+toasts if it isn't. */}
              {integration.id === 'plaid' && plaidStatus && (
                <div className="mb-3 space-y-2">
                  {!plaidStatus.configured && (
                    <div className="text-xs text-muted-foreground p-3 bg-background/40 border border-border rounded-lg leading-relaxed">
                      Plaid SDK not configured. Create{' '}
                      <code className="bg-secondary px-1 py-0.5 rounded font-mono">
                        ~/.config/compass/plaid.env
                      </code>{' '}
                      with <code className="font-mono">PLAID_CLIENT_ID</code> +{' '}
                      <code className="font-mono">PLAID_ENV</code> (
                      <code className="font-mono">sandbox</code> or{' '}
                      <code className="font-mono">production</code>) and relaunch.
                    </div>
                  )}
                  {plaidStatus.configured && plaidSecretInput !== null && (
                    <div className="p-3 bg-background/40 border border-border rounded-lg space-y-2">
                      <label
                        htmlFor="plaid-secret-input"
                        className="block text-xs text-muted-foreground"
                      >
                        Plaid secret ({plaidStatus.env})
                      </label>
                      <input
                        id="plaid-secret-input"
                        type="password"
                        placeholder="Paste your Plaid Sandbox Secret here"
                        aria-label="Plaid API secret"
                        value={plaidSecretInput}
                        onChange={(e) => setPlaidSecretInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitPlaidSecret()
                          else if (e.key === 'Escape') setPlaidSecretInput(null)
                        }}
                        className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void submitPlaidSecret()}
                          disabled={connecting === 'plaid' || !plaidSecretInput.trim()}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                        >
                          <Plug2 size={11} />
                          {connecting === 'plaid' ? 'Saving…' : 'Save secret'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPlaidSecretInput(null)}
                          className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {/* Connected Items list. Always shown when the secret is
                      configured AND the secret form isn't open. */}
                  {plaidStatus.configured && plaidStatus.hasSecret && plaidSecretInput === null && (
                    <div className="space-y-1.5">
                      {plaidItems.length === 0 && (
                        <p className="text-xs text-muted-foreground">No banks connected yet.</p>
                      )}
                      {plaidItems.map((item) => (
                        <div
                          key={item.itemId}
                          className="flex items-center justify-between gap-2 px-2 py-1.5 bg-background/40 border border-border rounded text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-foreground truncate">
                              {item.institutionName}
                            </div>
                            <div className="text-muted-foreground">
                              {item.errorCode ? (
                                <span className="text-red-400">
                                  {item.errorCode === 'ITEM_LOGIN_REQUIRED'
                                    ? 'Re-authentication required'
                                    : item.errorCode}
                                </span>
                              ) : item.lastSyncedAt ? (
                                `Last synced ${formatRelative(new Date(item.lastSyncedAt))}`
                              ) : (
                                'Never synced'
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              void disconnectPlaidItem(item.itemId, item.institutionName)
                            }
                            className="shrink-0 text-xs px-2 py-1 text-muted-foreground hover:text-destructive transition-colors"
                          >
                            Disconnect
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ─── Obsidian card body ────────────────────────────────────
                  Vault-path form (Connect / Change vault) or the configured
                  vault row. Local folder only — no secrets involved. */}
              {integration.id === 'obsidian' && obsidianPathInput !== null && (
                <div className="mb-3 p-3 bg-background/40 border border-border rounded-lg space-y-2">
                  <label
                    htmlFor="obsidian-vault-path-input"
                    className="block text-xs text-muted-foreground"
                  >
                    Vault folder (absolute path, ~ allowed)
                  </label>
                  <input
                    id="obsidian-vault-path-input"
                    type="text"
                    placeholder="~/Documents/My Vault"
                    aria-label="Obsidian vault folder path"
                    value={obsidianPathInput}
                    onChange={(e) => setObsidianPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitObsidianPath()
                      else if (e.key === 'Escape') setObsidianPathInput(null)
                    }}
                    className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Vault notes are imported under <code className="font-mono">obsidian/</code> in
                    your knowledge base; Compass notes are exported to a{' '}
                    <code className="font-mono">Compass/</code> folder in the vault. Each side is
                    one-way — no conflicts.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void submitObsidianPath()}
                      disabled={connecting === 'obsidian' || !obsidianPathInput.trim()}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                    >
                      <Plug2 size={11} />
                      {connecting === 'obsidian' ? 'Connecting…' : 'Connect & Sync'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setObsidianPathInput(null)}
                      className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {integration.id === 'obsidian' &&
                obsidianPathInput === null &&
                obsidianStatus?.configured && (
                  <div className="mb-3 flex items-center justify-between gap-2 px-2 py-1.5 bg-background/40 border border-border rounded text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {obsidianStatus.vaultPath}
                      </div>
                      {obsidianStatus.error ? (
                        <div className="text-red-400">{obsidianStatus.error}</div>
                      ) : (
                        !obsidianStatus.looksLikeVault && (
                          <div className="text-muted-foreground">
                            Plain folder (no .obsidian found)
                          </div>
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setObsidianPathInput(obsidianStatus.vaultPath ?? '')}
                      className="shrink-0 text-xs px-2 py-1 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Change vault
                    </button>
                  </div>
                )}

              {/* Inline Notion token form — internal-integration token,
                  same paste-once flow as the GitHub PAT. Only pages shared
                  with the integration are visible to the API. */}
              {integration.id === 'notion' && !isConnected && notionTokenInput !== null && (
                <div className="mb-3 p-3 bg-background/40 border border-border rounded-lg space-y-2">
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    Create an internal integration at{' '}
                    <a
                      href="https://www.notion.so/my-integrations"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
                    >
                      notion.so/my-integrations
                      <ExternalLink size={10} className="opacity-70" />
                    </a>
                    , paste its token here, then <em>share</em> the pages you want imported with
                    that integration (page menu ▸ Connections). Compass stores the token encrypted
                    on disk and only ever reads.
                  </div>
                  <label
                    htmlFor="notion-token-input"
                    className="block text-xs text-muted-foreground"
                  >
                    Notion integration token
                  </label>
                  <input
                    id="notion-token-input"
                    type="password"
                    placeholder="ntn_… or secret_…"
                    aria-label="Notion integration token"
                    value={notionTokenInput}
                    onChange={(e) => setNotionTokenInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitNotionToken()
                      else if (e.key === 'Escape') setNotionTokenInput(null)
                    }}
                    className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void submitNotionToken()}
                      disabled={connecting === 'notion' || !notionTokenInput.trim()}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                    >
                      <Plug2 size={11} />
                      {connecting === 'notion' ? 'Connecting…' : 'Connect'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNotionTokenInput(null)}
                      className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Inline Google credentials form. Replaces the .env workflow
                  with paste-once UX. Saved values are encrypted via safeStorage
                  and never cross the IPC boundary again. */}
              {integration.id === 'google' && !isConnected && googleCredsInput !== null && (
                <div className="mb-3 p-3 bg-background/40 border border-border rounded-lg space-y-2">
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    Paste your Google OAuth Client ID + Secret from{' '}
                    <a
                      href="https://console.cloud.google.com/apis/credentials"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
                    >
                      Google Cloud Console
                      <ExternalLink size={10} className="opacity-70" />
                    </a>
                    . Compass stores them encrypted on disk and reuses them on every{' '}
                    <em>Connect</em>; no{' '}
                    <code className="bg-secondary px-1 py-0.5 rounded font-mono">.env</code>{' '}
                    editing.
                  </div>
                  <label
                    htmlFor="google-client-id-input"
                    className="block text-xs text-muted-foreground"
                  >
                    Client ID
                  </label>
                  <input
                    id="google-client-id-input"
                    type="text"
                    placeholder="123456789012-abc...apps.googleusercontent.com"
                    aria-label="Google OAuth Client ID"
                    value={googleCredsInput.clientId}
                    onChange={(e) =>
                      setGoogleCredsInput((prev) =>
                        prev ? { ...prev, clientId: e.target.value } : prev
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setGoogleCredsInput(null)
                    }}
                    className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
                  />
                  <label
                    htmlFor="google-client-secret-input"
                    className="block text-xs text-muted-foreground"
                  >
                    Client Secret
                  </label>
                  <input
                    id="google-client-secret-input"
                    type="password"
                    placeholder="GOCSPX-..."
                    aria-label="Google OAuth Client Secret"
                    value={googleCredsInput.clientSecret}
                    onChange={(e) =>
                      setGoogleCredsInput((prev) =>
                        prev ? { ...prev, clientSecret: e.target.value } : prev
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitGoogleCredentials()
                      else if (e.key === 'Escape') setGoogleCredsInput(null)
                    }}
                    className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void submitGoogleCredentials()}
                      disabled={
                        connecting === 'google' ||
                        !googleCredsInput.clientId.trim() ||
                        !googleCredsInput.clientSecret.trim()
                      }
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                    >
                      <Plug2 size={11} />
                      {connecting === 'google' ? 'Connecting…' : 'Save & Connect'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setGoogleCredsInput(null)}
                      className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
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
                {/* Plaid is multi-Item: Disconnect is a per-row button inside
                    the card body, NOT this card-level Disconnect. The
                    card-level button is always "Connect bank" so the user
                    can add additional institutions. */}
                {isConnected && integration.id !== 'plaid' ? (
                  <button
                    type="button"
                    onClick={() => disconnect(integration.id)}
                    className="text-xs px-3 py-1.5 border border-border hover:border-destructive text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                  >
                    Disconnect
                  </button>
                ) : (integration.id === 'github' && githubPatInput !== null) ||
                  (integration.id === 'google' && googleCredsInput !== null) ||
                  (integration.id === 'plaid' && plaidSecretInput !== null) ||
                  (integration.id === 'obsidian' && obsidianPathInput !== null) ||
                  (integration.id === 'notion' && notionTokenInput !== null) ? null : (
                  <button
                    type="button"
                    onClick={() => connect(integration.id)}
                    disabled={connecting === integration.id}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Plug2 size={11} />
                    {connecting === integration.id
                      ? 'Connecting…'
                      : integration.id === 'plaid' && plaidItems.length > 0
                        ? 'Connect bank'
                        : 'Connect'}
                  </button>
                )}
                {/* Edit credentials — visible whenever Google creds are stored
                    and the form isn't already open. Without this, a user who
                    pastes the wrong secret (or rotates it on Google's side)
                    has no in-app way to fix it. */}
                {integration.id === 'google' &&
                  googleCredsConfigured &&
                  googleCredsInput === null && (
                    <button
                      type="button"
                      onClick={() => editGoogleCredentials()}
                      className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Edit credentials
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
