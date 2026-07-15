import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plug2,
  Search
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import IntegrationCard from '../components/integrations/IntegrationCard'
import IntegrationSetupPanel from '../components/integrations/IntegrationSetupPanel'
import RelaySettings from '../components/integrations/RelaySettings'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import {
  INTEGRATION_CATEGORY_LABELS,
  INTEGRATION_CATEGORY_ORDER,
  INTEGRATION_REGISTRY,
  type IntegrationCategory,
  type IntegrationMeta,
  groupByCategory
} from '../lib/integration-registry'
import { getIntegrationSetup } from '../lib/integration-setup'
import { type CardState, deriveCardState } from '../lib/integration-status'
import { cn, formatRelative } from '../lib/utils'

type IntegrationConfig = IntegrationMeta

const ALL_INTEGRATIONS = Object.values(INTEGRATION_REGISTRY)
const INTEGRATIONS = ALL_INTEGRATIONS.filter((i) => i.connected)
const UPCOMING_INTEGRATIONS = ALL_INTEGRATIONS.filter((i) => !i.connected)

// Ids whose card body is a bespoke, multi-field / multi-connection flow that
// predates the declarative setup panel. Everything else renders through
// <IntegrationSetupPanel>. Keep in sync with the switch in the card body below.
const BESPOKE_BODY_IDS = new Set(['google', 'plaid', 'simplefin', 'snaptrade', 'obsidian'])

export default function Integrations(): JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({})
  const [syncing, setSyncing] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState<string | null>(null)
  const [syncLog, setSyncLog] = useState<
    Array<{ service: string; time: Date; records: number; error?: string }>
  >([])
  const [setupOpen, setSetupOpen] = useState(false)
  // Relay Settings section (self-host URL + connectivity test). Opened directly
  // by the "Open Relay settings" link on a relay aggregator's error banner.
  const [relayOpen, setRelayOpen] = useState(false)
  // Search + category filter for the integration grid — kept simple (client-
  // side substring match) since the registry is small enough today, but this
  // is what keeps the page scannable as more integrations land.
  const [integrationSearch, setIntegrationSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<IntegrationCategory | 'all'>('all')
  const [redirectUris, setRedirectUris] = useState<{ google: string; github: string } | null>(null)
  // SnapTrade BYO setup form (clientId + consumerKey), shown on Connect when the
  // partner credentials aren't stored yet. Null = collapsed.
  const [snaptradeSetupInput, setSnaptradeSetupInput] = useState<{
    clientId: string
    consumerKey: string
  } | null>(null)
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
    hasConfig: boolean
    env: 'sandbox' | 'production' | null
    clientId: string | null
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
  // Inline Plaid setup form (client_id + environment + secret), shown on
  // Connect when Plaid isn't fully configured, and re-openable to fix wrong
  // credentials. null = collapsed. Replaces the old hand-edit-a-file flow.
  const [plaidSetupInput, setPlaidSetupInput] = useState<{
    clientId: string
    env: 'sandbox' | 'production'
    secret: string
  } | null>(null)
  // SimpleFIN state. `connections` is the list of claimed SimpleFIN connections
  // (one per setup token), rendered as sub-rows inside the card — mirrors the
  // multi-Item Plaid treatment. `tokenInput` is the paste-setup-token form:
  // null = collapsed, string = open with the current value.
  const [simplefinConnections, setSimplefinConnections] = useState<
    Array<{
      id: number
      connectionId: string
      orgName: string
      orgDomain: string | null
      lastSyncedAt: number | null
      errorCode: string | null
      historyOldestDate: string | null
      historyBackfillStatus: 'complete' | 'partial' | 'error' | null
    }>
  >([])
  const [simplefinTokenInput, setSimplefinTokenInput] = useState<string | null>(null)
  // connectionId currently running an "Import full history" backfill (single
  // request/response promise, no progress channel — see plan). Only one at a
  // time; the button for that row shows a busy label and disables.
  const [simplefinBackfillingId, setSimplefinBackfillingId] = useState<string | null>(null)
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
  // Generic credential inputs for declarative (setup-panel) integrations,
  // keyed by integration id → { fieldKey → value }. Replaces the per-service
  // *Input string states (GitHub PAT, Notion/Linear/Todoist/Oura tokens): the
  // panel renders the inputs inline from the spec and writes here.
  const [fieldValues, setFieldValues] = useState<Record<string, Record<string, string>>>({})
  // Terra BYO-direct credentials (dev-id + x-api-key) — the "advanced" escape
  // hatch surfaced by the setup panel for the one relay aggregator that allows it.
  const [terraByo, setTerraByo] = useState<Record<string, string>>({})
  // Persistent per-card connect errors — a failed connect (esp. a relay
  // aggregator with no integrations row yet) surfaces here so the card banner
  // stays visible instead of vanishing with the toast.
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({})
  const { toast } = useToast()
  const confirm = useConfirm()

  function setField(id: string, key: string, value: string): void {
    setFieldValues((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }))
  }
  function clearFields(id: string): void {
    setFieldValues((prev) => ({ ...prev, [id]: {} }))
  }
  function setConnectError(id: string, message: string | null): void {
    setConnectErrors((prev) => {
      if (message === null) {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      return { ...prev, [id]: message }
    })
  }

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
    void loadSimplefin()
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
      // SimpleFIN, like Plaid, keeps lastSyncedAt + errorCode on per-connection
      // rows, so refresh the connection list on its sync events.
      if (d.service === 'simplefin') void loadSimplefin()
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

  // Bespoke "Connect" entry points — the multi-field / multi-connection flows
  // that own their own card body (Google, Plaid, SimpleFIN, SnapTrade,
  // Obsidian). Paste-token / relay-widget / local-file integrations go through
  // the declarative setup panel (submitToken / relayConnect / localConnect).
  async function connect(service: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    // Google: if credentials aren't stored yet, open the credentials form
    // first. Once stored, Connect proceeds to the OAuth dance directly.
    if (service === 'google') {
      if (!googleCredsConfigured) {
        setGoogleCredsInput({ clientId: '', clientSecret: '' })
        return
      }
      setConnecting('google')
      try {
        const result = await window.api.auth.connectGoogle()
        if (result.error) {
          toast(`Connection failed: ${result.error}`, 'error')
        } else {
          await loadStatuses()
          triggerSync('google')
        }
      } finally {
        setConnecting(null)
      }
      return
    }
    // Plaid:
    //   - Status not yet loaded → kick off the load + bail.
    //   - Not fully configured → open the in-app setup form, prefilling any
    //     client_id/env we already have.
    //   - Otherwise → start Plaid Link (the child window flow).
    if (service === 'plaid') {
      if (plaidStatus === null) {
        toast('Loading Plaid status — try again in a moment.', 'info')
        void loadPlaid()
        return
      }
      if (!plaidStatus.configured) {
        setPlaidSetupInput({
          clientId: plaidStatus.clientId ?? '',
          env: plaidStatus.env ?? 'sandbox',
          secret: ''
        })
        return
      }
      void connectPlaidBank()
      return
    }
    // SimpleFIN: paste-once setup token (base64). Connect opens the token form.
    if (service === 'simplefin') {
      setSimplefinTokenInput('')
      return
    }
    // Obsidian: Connect opens the vault-path form.
    if (service === 'obsidian') {
      setObsidianPathInput(obsidianStatus?.vaultPath ?? '')
      return
    }
    // SnapTrade (BYO-direct): needs partner credentials first, then opens the
    // Connection Portal; a sync pulls holdings into net worth.
    if (service === 'snaptrade') {
      const hasCreds = await window.api.snaptrade.hasCreds().catch(() => false)
      if (!hasCreds) {
        setSnaptradeSetupInput({ clientId: '', consumerKey: '' })
        return
      }
      await runSnaptradeConnect()
    }
  }

  // Paste-token integrations (GitHub PAT, Notion, Linear, Todoist, Oura) — the
  // panel renders the token input inline; this claims it. Preserves each
  // service's friendly success message (login / workspace).
  async function submitToken(id: string) {
    const token = (fieldValues[id]?.token ?? '').trim()
    if (!token) {
      toast('Paste your token first.', 'error')
      return
    }
    setConnecting(id)
    try {
      let error: string | undefined
      let okMsg = `${INTEGRATION_REGISTRY[id]?.name ?? id} connected.`
      if (id === 'github') {
        const r = await window.api.auth.connectGitHubWithPAT(token)
        error = r.error
        if (!error) okMsg = `Connected as @${r.login ?? 'github user'}`
      } else if (id === 'notion') {
        const r = await window.api.auth.connectNotion(token)
        error = r.error
        if (!error && r.workspace) okMsg = `Connected to ${r.workspace}.`
      } else if (id === 'linear') {
        const r = await window.api.auth.connectLinear(token)
        error = r.error
        if (!error && r.name) okMsg = `Connected as ${r.name}.`
      } else if (id === 'todoist') {
        error = (await window.api.auth.connectTodoist(token)).error
      } else if (id === 'oura') {
        error = (await window.api.auth.connectOura(token)).error
      }
      if (error) {
        toast(`Connection failed: ${error}`, 'error')
        setConnectError(id, error)
        return
      }
      setConnectError(id, null)
      toast(okMsg, 'success')
      clearFields(id)
      await loadStatuses()
      triggerSync(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't connect: ${msg}`, 'error')
      setConnectError(id, msg)
    } finally {
      setConnecting(null)
    }
  }

  // Relay-fronted aggregators (Terra, Canopy, Argyle, Arcadia, Metriport,
  // Nylas, Knot). One generic path: open the relay widget, then sync. On
  // failure the error is persisted on the card (loadStatuses reads the
  // integrations row errorMessage) in addition to the toast.
  async function relayConnect(id: string) {
    const connectors: Record<
      string,
      { call: () => Promise<{ success: boolean; error?: string }>; okMsg: string }
    > = {
      terra: {
        call: () => window.api.terra.connect(),
        okMsg: 'Terra connected — syncing your wearables…'
      },
      canopy: {
        call: () => window.api.canopy.connect(),
        okMsg: 'Canopy connected — importing your policies…'
      },
      argyle: {
        call: () => window.api.argyle.connect(),
        okMsg: 'Argyle connected — importing your paystubs…'
      },
      arcadia: {
        call: () => window.api.arcadia.connect(),
        okMsg: 'Arcadia connected — importing your utility bills…'
      },
      metriport: {
        call: () => window.api.metriport.connect(),
        okMsg: 'Metriport connected — fetching your medical records…'
      },
      nylas: {
        call: () => window.api.nylas.connect(),
        okMsg: 'Nylas connected — importing your contacts…'
      },
      knot: {
        call: () => window.api.knot.connect(),
        okMsg: 'Knot connected — importing your purchases…'
      }
    }
    const conn = connectors[id]
    if (!conn) return
    setConnecting(id)
    try {
      const r = await conn.call()
      if (!r.success) {
        const msg = r.error ?? 'unknown error'
        toast(`${INTEGRATION_REGISTRY[id]?.name ?? id} connection failed: ${msg}`, 'error')
        setConnectError(id, msg)
        await loadStatuses()
        return
      }
      setConnectError(id, null)
      toast(conn.okMsg, 'success')
      await loadStatuses()
      triggerSync(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't connect: ${msg}`, 'error')
      setConnectError(id, msg)
      await loadStatuses()
    } finally {
      setConnecting(null)
    }
  }

  // Terra BYO-direct: store the user's own Terra dev-id + x-api-key, then run
  // the (now BYO) connect which bypasses the relay entirely.
  async function submitTerraByo() {
    const devId = (terraByo.devId ?? '').trim()
    const apiKey = (terraByo.apiKey ?? '').trim()
    if (!devId || !apiKey) {
      toast('Enter both your Terra dev-id and x-api-key.', 'error')
      return
    }
    setConnecting('terra')
    try {
      const r = await window.api.terra.setByo(devId, apiKey)
      if (!r.success) {
        toast(r.error ?? 'Failed to save Terra keys.', 'error')
        return
      }
      setTerraByo({})
      await relayConnect('terra')
    } finally {
      setConnecting(null)
    }
  }

  // Local-file integrations (Apple Calendar, Things) — no OAuth, just kick off
  // a sync which creates the integration row on first success. Surfaces the
  // record count so the user gets real feedback instead of a silent no-op.
  async function localConnect(id: string) {
    setConnecting(id)
    try {
      const r = await window.api.sync.triggerSync(id)
      if (r && 'error' in r && r.error) {
        toast(`Sync failed: ${r.error}`, 'error')
        setConnectError(id, r.error)
      } else if (r && 'recordsUpdated' in r && typeof r.recordsUpdated === 'number') {
        setConnectError(id, null)
        toast(
          `${INTEGRATION_REGISTRY[id]?.name ?? id} connected — ${r.recordsUpdated} items synced.`,
          'success'
        )
      } else {
        setConnectError(id, null)
        toast(`${INTEGRATION_REGISTRY[id]?.name ?? id} connected.`, 'success')
      }
      await loadStatuses()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Couldn't connect: ${msg}`, 'error')
      setConnectError(id, msg)
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
        hasConfig: status.hasConfig,
        env: status.env,
        clientId: status.clientId,
        hasSecret: status.hasSecret
      })
      setPlaidItems(items)
    } catch {
      /* IPC may not be wired in non-electron contexts (Storybook etc.); ignore */
    }
  }

  // Refresh the SimpleFIN connection list. Called on mount, after claim /
  // disconnect, and after every simplefin sync event.
  async function loadSimplefin(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.simplefin) return
    try {
      setSimplefinConnections(await api.simplefin.listConnections())
    } catch {
      /* IPC may not be wired in non-electron contexts; ignore */
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

  async function submitPlaidSetup() {
    if (plaidSetupInput === null) return
    const clientId = plaidSetupInput.clientId.trim()
    const secret = plaidSetupInput.secret.trim()
    const env = plaidSetupInput.env
    if (!clientId) {
      toast('Enter your Plaid Client ID.', 'error')
      return
    }
    if (!secret) {
      toast('Paste your Plaid secret.', 'error')
      return
    }
    setConnecting('plaid')
    try {
      await window.api.plaid.setConfig(clientId, env)
      await window.api.plaid.setSecret(env, secret)
      toast('Plaid credentials saved.', 'success')
      setPlaidSetupInput(null)
      await loadPlaid()
      // Credentials are in place — proceed straight to the bank picker.
      await connectPlaidBank()
    } catch (err) {
      toast(
        `Couldn't save Plaid setup: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
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

  async function submitSimplefinToken() {
    if (simplefinTokenInput === null) return
    const token = simplefinTokenInput.trim()
    if (!token) {
      toast('Paste your SimpleFIN setup token.', 'error')
      return
    }
    setConnecting('simplefin')
    try {
      const r = await window.api.simplefin.claimToken(token)
      const linkedNote =
        r.accountsLinked > 0 ? ` · ${r.accountsLinked} matched to existing accounts` : ''
      toast(
        `Connected ${r.orgName || 'SimpleFIN'} — ${r.added} transaction${r.added === 1 ? '' : 's'} imported${linkedNote}.`,
        'success'
      )
      setSimplefinTokenInput(null)
      await loadSimplefin()
      await loadStatuses()
    } catch (err) {
      // The setup token is single-use; a re-paste of a spent token 4xxs here.
      toast(
        `Couldn't connect SimpleFIN: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    } finally {
      setConnecting(null)
    }
  }

  async function disconnectSimplefinConnection(connectionId: string, orgName: string) {
    const label = orgName || 'this connection'
    const ok = await confirm({
      title: `Disconnect ${label}?`,
      description:
        'SimpleFIN will stop syncing these accounts. Existing transactions stay in Compass. You can reconnect later with a fresh setup token.',
      confirmLabel: 'Disconnect',
      destructive: false
    })
    if (!ok) return
    await window.api.simplefin.disconnect(connectionId)
    toast(`Disconnected ${label}.`, 'success')
    await loadSimplefin()
  }

  async function backfillSimplefinConnectionHistory(connectionId: string, orgName: string) {
    const label = orgName || 'this connection'
    const ok = await confirm({
      title: `Import full history for ${label}?`,
      description:
        'Compass will walk backward through your transaction history in date-windowed requests to your SimpleFIN bridge until it runs out of data. This may take a minute and make several requests. Safe to run more than once — it resumes from where it left off.',
      confirmLabel: 'Import',
      destructive: false
    })
    if (!ok) return
    setSimplefinBackfillingId(connectionId)
    try {
      const r = await window.api.simplefin.backfillHistory(connectionId)
      if (r.status === 'error') {
        toast(
          `Historical import for ${label} stopped: ${r.errorMessage ?? 'unknown error'}`,
          'error'
        )
      } else {
        const oldest = r.oldestDateReached
          ? new Date(`${r.oldestDateReached}T00:00:00Z`).toLocaleDateString(undefined, {
              month: 'short',
              year: 'numeric'
            })
          : 'the start'
        const moreNote =
          r.status === 'partial' ? ' — more history may exist; import again to continue' : ''
        toast(
          `Imported ${r.added} transaction${r.added === 1 ? '' : 's'} for ${label} back to ${oldest}${moreNote}.`,
          'success'
        )
      }
      await loadSimplefin()
    } catch (err) {
      toast(
        `Couldn't import history for ${label}: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    } finally {
      setSimplefinBackfillingId(null)
    }
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

  // Open the SnapTrade Connection Portal, then kick off a holdings sync.
  async function runSnaptradeConnect() {
    setConnecting('snaptrade')
    try {
      const r = await window.api.snaptrade.connect()
      if (!r.success) {
        toast(`SnapTrade connection failed: ${r.error ?? 'unknown error'}`, 'error')
        return
      }
      toast('SnapTrade connected — importing your holdings…', 'success')
      await loadStatuses()
      triggerSync('snaptrade')
    } catch (err) {
      toast(`Couldn't connect: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setConnecting(null)
    }
  }

  // Save the user's SnapTrade partner credentials, then open the portal.
  async function submitSnaptradeSetup() {
    if (snaptradeSetupInput === null) return
    const clientId = snaptradeSetupInput.clientId.trim()
    const consumerKey = snaptradeSetupInput.consumerKey.trim()
    if (!clientId || !consumerKey) {
      toast('Enter both your SnapTrade clientId and consumerKey.', 'error')
      return
    }
    const r = await window.api.snaptrade.setByo(clientId, consumerKey)
    if (!r.success) {
      toast(r.error ?? 'Failed to save credentials.', 'error')
      return
    }
    setSnaptradeSetupInput(null)
    await runSnaptradeConnect()
  }

  // Shared with dismissError() below — the actual state-clearing branch per
  // service, independent of whether a confirm dialog gates it.
  async function clearIntegrationState(service: string): Promise<void> {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    // Obsidian has no OAuth token — disconnect = forget the vault path.
    // Files already mirrored (both directions) stay where they are.
    if (service === 'obsidian') {
      await window.api.obsidian.clear()
      await loadObsidian()
    } else if (service === 'snaptrade') {
      // Dedicated handler: forgets the connected user but keeps the BYO
      // partner clientId/consumerKey, unlike the generic auth:disconnect
      // (which would wipe the whole token blob and force re-entering them).
      await window.api.snaptrade.disconnect()
    } else {
      await window.api.auth.disconnect(service)
    }
    await loadStatuses()
  }

  async function disconnect(service: string) {
    const ok = await confirm({
      title: `Disconnect ${service}?`,
      description: 'Your synced data will remain in the app. You can reconnect at any time.',
      confirmLabel: 'Disconnect',
      destructive: false
    })
    if (!ok) return
    await clearIntegrationState(service)
  }

  // Clears a stuck "Error" state on a card that never successfully connected
  // (e.g. Things 3 when the app isn't installed) — no confirm dialog, since
  // there's no connection or synced data to lose, just a persistent red
  // banner with no other way to dismiss it short of a successful retry.
  async function dismissError(service: string): Promise<void> {
    setConnectError(service, null)
    await clearIntegrationState(service)
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

  const matchesFilter = useCallback(
    (integration: IntegrationConfig): boolean => {
      if (categoryFilter !== 'all' && integration.category !== categoryFilter) return false
      if (!integrationSearch.trim()) return true
      const q = integrationSearch.trim().toLowerCase()
      return (
        integration.name.toLowerCase().includes(q) ||
        integration.description.toLowerCase().includes(q) ||
        INTEGRATION_CATEGORY_LABELS[integration.category].toLowerCase().includes(q)
      )
    },
    [integrationSearch, categoryFilter]
  )

  const availableGroups = useMemo(
    () => groupByCategory(INTEGRATIONS.filter(matchesFilter)),
    [matchesFilter]
  )
  const comingSoonGroups = useMemo(
    () => groupByCategory(UPCOMING_INTEGRATIONS.filter(matchesFilter)),
    [matchesFilter]
  )

  // The bespoke inner body (config forms + connection lists) for the five
  // multi-field / multi-connection integrations that predate the setup panel.
  function renderBespokeBody(integration: IntegrationMeta, state: CardState): JSX.Element | null {
    const id = integration.id
    const isConnected = state.isConnected

    if (id === 'plaid' && plaidStatus) {
      return (
        <div className="mb-3 space-y-2">
          {plaidSetupInput !== null && (
            <div className="p-3 bg-background/40 border border-border rounded-lg space-y-2">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Compass uses your own Plaid developer keys. Get a free Client ID + Secret from{' '}
                <a
                  href="https://dashboard.plaid.com/developers/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  the Plaid dashboard
                </a>{' '}
                (Sandbox is instant; Production needs Plaid approval).
              </p>
              <label htmlFor="plaid-client-id" className="block text-xs text-muted-foreground">
                Client ID
              </label>
              <input
                id="plaid-client-id"
                type="text"
                placeholder="e.g. 5f1a2b3c4d5e6f7a8b9c0d1e"
                aria-label="Plaid Client ID"
                value={plaidSetupInput.clientId}
                onChange={(e) =>
                  setPlaidSetupInput((p) => (p ? { ...p, clientId: e.target.value } : p))
                }
                className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
              />
              <label htmlFor="plaid-env" className="block text-xs text-muted-foreground">
                Environment
              </label>
              <select
                id="plaid-env"
                aria-label="Plaid environment"
                value={plaidSetupInput.env}
                onChange={(e) =>
                  setPlaidSetupInput((p) =>
                    p ? { ...p, env: e.target.value as 'sandbox' | 'production' } : p
                  )
                }
                className="w-full text-xs px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="sandbox">Sandbox (test data)</option>
                <option value="production">Production (real banks)</option>
              </select>
              <label htmlFor="plaid-secret-input" className="block text-xs text-muted-foreground">
                {plaidSetupInput.env} Secret
              </label>
              <input
                id="plaid-secret-input"
                type="password"
                placeholder={`Paste your Plaid ${plaidSetupInput.env} secret`}
                aria-label="Plaid API secret"
                value={plaidSetupInput.secret}
                onChange={(e) =>
                  setPlaidSetupInput((p) => (p ? { ...p, secret: e.target.value } : p))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitPlaidSetup()
                  else if (e.key === 'Escape') setPlaidSetupInput(null)
                }}
                className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void submitPlaidSetup()}
                  disabled={
                    connecting === 'plaid' ||
                    !plaidSetupInput.clientId.trim() ||
                    !plaidSetupInput.secret.trim()
                  }
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                >
                  <Plug2 size={11} />
                  {connecting === 'plaid' ? 'Saving…' : 'Save & connect'}
                </button>
                <button
                  type="button"
                  onClick={() => setPlaidSetupInput(null)}
                  className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!plaidStatus.configured && plaidSetupInput === null && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              Connect to set up Plaid with your own (free) Plaid developer keys — no files to edit.
            </p>
          )}
          {plaidStatus.configured && plaidSetupInput === null && (
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
                    onClick={() => void disconnectPlaidItem(item.itemId, item.institutionName)}
                    className="shrink-0 text-xs px-2 py-1 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setPlaidSetupInput({
                    clientId: plaidStatus.clientId ?? '',
                    env: plaidStatus.env ?? 'sandbox',
                    secret: ''
                  })
                }
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Edit Plaid credentials
              </button>
            </div>
          )}
        </div>
      )
    }

    if (id === 'simplefin') {
      return (
        <div className="mb-3 space-y-2">
          {simplefinTokenInput !== null && (
            <div className="p-3 bg-background/40 border border-border rounded-lg space-y-2">
              <p className="text-xs text-muted-foreground leading-relaxed">
                You hold the keys with SimpleFIN. Create an account at{' '}
                <a
                  href="https://bridge.simplefin.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  bridge.simplefin.org
                </a>{' '}
                ($15/yr), link your banks &amp; cards, generate a one-time setup token, and paste it
                below. Compass claims it for a read-only access key stored encrypted on this Mac.
              </p>
              <label
                htmlFor="simplefin-token-input"
                className="block text-xs text-muted-foreground"
              >
                Setup token
              </label>
              <textarea
                id="simplefin-token-input"
                placeholder="Paste your SimpleFIN setup token (a long base64 string)"
                aria-label="SimpleFIN setup token"
                value={simplefinTokenInput}
                onChange={(e) => setSimplefinTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSimplefinTokenInput(null)
                }}
                rows={3}
                className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40 resize-none"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void submitSimplefinToken()}
                  disabled={connecting === 'simplefin' || !simplefinTokenInput.trim()}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
                >
                  <Plug2 size={11} />
                  {connecting === 'simplefin' ? 'Connecting…' : 'Claim & sync'}
                </button>
                <button
                  type="button"
                  onClick={() => setSimplefinTokenInput(null)}
                  className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {simplefinTokenInput === null && (
            <div className="space-y-1.5">
              {simplefinConnections.length === 0 && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Connect to link your banks &amp; cards through SimpleFIN — no business or
                  developer keys, just a one-time setup token.
                </p>
              )}
              {simplefinConnections.map((conn) => (
                <div
                  key={conn.connectionId}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 bg-background/40 border border-border rounded text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {conn.orgName || 'SimpleFIN connection'}
                    </div>
                    <div className="text-muted-foreground">
                      {conn.errorCode ? (
                        <span className="text-red-400">{conn.errorCode}</span>
                      ) : conn.lastSyncedAt ? (
                        `Last synced ${formatRelative(new Date(conn.lastSyncedAt))}`
                      ) : (
                        'Never synced'
                      )}
                    </div>
                    {conn.historyBackfillStatus === 'complete' && conn.historyOldestDate && (
                      <div className="text-muted-foreground">
                        Full history imported back to{' '}
                        {new Date(`${conn.historyOldestDate}T00:00:00Z`).toLocaleDateString(
                          undefined,
                          { month: 'short', year: 'numeric' }
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {conn.historyBackfillStatus !== 'complete' && (
                      <button
                        type="button"
                        disabled={simplefinBackfillingId !== null}
                        onClick={() =>
                          void backfillSimplefinConnectionHistory(conn.connectionId, conn.orgName)
                        }
                        className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      >
                        {simplefinBackfillingId === conn.connectionId
                          ? 'Importing…'
                          : conn.historyBackfillStatus === 'partial'
                            ? 'Import more history'
                            : 'Import full history'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void disconnectSimplefinConnection(conn.connectionId, conn.orgName)
                      }
                      className="text-xs px-2 py-1 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    if (id === 'obsidian') {
      return (
        <>
          {obsidianPathInput !== null && (
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
                Vault notes are imported under <code className="font-mono">obsidian/</code> in your
                knowledge base; Compass notes are exported to a{' '}
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
          {obsidianPathInput === null && obsidianStatus?.configured && (
            <div className="mb-3 flex items-center justify-between gap-2 px-2 py-1.5 bg-background/40 border border-border rounded text-xs">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">
                  {obsidianStatus.vaultPath}
                </div>
                {obsidianStatus.error ? (
                  <div className="text-red-400">{obsidianStatus.error}</div>
                ) : (
                  !obsidianStatus.looksLikeVault && (
                    <div className="text-muted-foreground">Plain folder (no .obsidian found)</div>
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
        </>
      )
    }

    if (id === 'google' && !isConnected && googleCredsInput !== null) {
      return (
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
            . Compass stores them encrypted on disk and reuses them on every <em>Connect</em>; no{' '}
            <code className="bg-secondary px-1 py-0.5 rounded font-mono">.env</code> editing.
          </div>
          <label htmlFor="google-client-id-input" className="block text-xs text-muted-foreground">
            Client ID
          </label>
          <input
            id="google-client-id-input"
            type="text"
            placeholder="123456789012-abc...apps.googleusercontent.com"
            aria-label="Google OAuth Client ID"
            value={googleCredsInput.clientId}
            onChange={(e) =>
              setGoogleCredsInput((prev) => (prev ? { ...prev, clientId: e.target.value } : prev))
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
      )
    }

    if (id === 'snaptrade' && !isConnected && snaptradeSetupInput !== null) {
      return (
        <div className="mb-3 p-3 bg-background/40 border border-border rounded-lg space-y-2">
          <div className="text-xs text-muted-foreground leading-relaxed">
            Paste your SnapTrade partner keys (free dev tier). Compass stores them encrypted on disk
            and signs each request locally.{' '}
            <a
              href="https://snaptrade.com/register"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
            >
              Get keys
              <ExternalLink size={10} className="opacity-70" />
            </a>
          </div>
          <label htmlFor="snaptrade-client-id" className="block text-xs text-muted-foreground">
            Client ID
          </label>
          <input
            id="snaptrade-client-id"
            type="text"
            placeholder="Your SnapTrade clientId"
            value={snaptradeSetupInput.clientId}
            onChange={(e) =>
              setSnaptradeSetupInput((s) => (s ? { ...s, clientId: e.target.value } : s))
            }
            className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
          />
          <label htmlFor="snaptrade-consumer-key" className="block text-xs text-muted-foreground">
            Consumer Key
          </label>
          <input
            id="snaptrade-consumer-key"
            type="password"
            placeholder="Your SnapTrade consumerKey"
            value={snaptradeSetupInput.consumerKey}
            onChange={(e) =>
              setSnaptradeSetupInput((s) => (s ? { ...s, consumerKey: e.target.value } : s))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitSnaptradeSetup()
              else if (e.key === 'Escape') setSnaptradeSetupInput(null)
            }}
            className="w-full text-xs font-mono px-2 py-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submitSnaptradeSetup()}
              disabled={
                connecting === 'snaptrade' ||
                !snaptradeSetupInput.clientId.trim() ||
                !snaptradeSetupInput.consumerKey.trim()
              }
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors disabled:opacity-50"
            >
              <Plug2 size={11} />
              {connecting === 'snaptrade' ? 'Connecting…' : 'Connect'}
            </button>
            <button
              type="button"
              onClick={() => setSnaptradeSetupInput(null)}
              className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }

    return null
  }

  // Shared connect/disconnect footer for the bespoke (multi-field /
  // multi-connection) card bodies. Declarative integrations render their own
  // footer inside <IntegrationSetupPanel>.
  function renderBespokeFooter(integration: IntegrationMeta, state: CardState): JSX.Element {
    const id = integration.id
    const formOpen =
      (id === 'google' && googleCredsInput !== null) ||
      (id === 'plaid' && plaidSetupInput !== null) ||
      (id === 'simplefin' && simplefinTokenInput !== null) ||
      (id === 'obsidian' && obsidianPathInput !== null) ||
      (id === 'snaptrade' && snaptradeSetupInput !== null)
    const connectLabel =
      (id === 'plaid' && plaidItems.length > 0) ||
      (id === 'simplefin' && simplefinConnections.length > 0)
        ? 'Connect bank'
        : 'Connect'
    return (
      <div className="flex gap-2 mt-3">
        {state.isConnected && !state.isMultiConn ? (
          <button
            type="button"
            onClick={() => disconnect(id)}
            className="text-xs px-3 py-1.5 border border-border hover:border-destructive text-muted-foreground hover:text-destructive rounded-lg transition-colors"
          >
            Disconnect
          </button>
        ) : formOpen ? null : (
          <button
            type="button"
            onClick={() => connect(id)}
            disabled={connecting === id}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50"
          >
            <Plug2 size={11} />
            {connecting === id ? 'Connecting…' : connectLabel}
          </button>
        )}
        {id === 'google' && googleCredsConfigured && googleCredsInput === null && (
          <button
            type="button"
            onClick={() => editGoogleCredentials()}
            className="text-xs px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            Edit credentials
          </button>
        )}
      </div>
    )
  }

  // The card body: a declarative setup panel for simple auth kinds, or the
  // existing bespoke flow for Google / Plaid / SimpleFIN / SnapTrade / Obsidian.
  function renderCardBody(integration: IntegrationMeta, state: CardState): JSX.Element {
    const id = integration.id
    const setup = getIntegrationSetup(id)

    if (!BESPOKE_BODY_IDS.has(id) && setup) {
      return (
        <IntegrationSetupPanel
          setup={setup}
          connected={state.isConnected}
          busy={connecting === id}
          values={fieldValues[id] ?? {}}
          onChange={(key, value) => setField(id, key, value)}
          onConnect={() => {
            if (setup.authKind === 'paste-token') void submitToken(id)
            else if (setup.authKind === 'relay-widget') void relayConnect(id)
            else if (setup.authKind === 'local-file') void localConnect(id)
            else if (setup.authKind === 'google-linked') void localConnect(id)
          }}
          onDisconnect={() => disconnect(id)}
          byo={
            id === 'terra'
              ? {
                  fields: [
                    {
                      key: 'devId',
                      label: 'Terra dev-id',
                      type: 'text',
                      placeholder: 'Your Terra dev-id'
                    },
                    {
                      key: 'apiKey',
                      label: 'Terra x-api-key',
                      type: 'password',
                      placeholder: 'Your Terra x-api-key'
                    }
                  ],
                  values: terraByo,
                  onChange: (key, value) => setTerraByo((prev) => ({ ...prev, [key]: value })),
                  onSubmit: () => void submitTerraByo(),
                  busy: connecting === 'terra'
                }
              : undefined
          }
          onOpenRelaySettings={setup.requiresRelay ? () => setRelayOpen(true) : undefined}
        />
      )
    }

    return (
      <>
        {renderBespokeBody(integration, state)}
        {renderBespokeFooter(integration, state)}
      </>
    )
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
                Google (Calendar · Gmail · Drive · Contacts)
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
                  <strong className="text-foreground">Gmail API</strong>,{' '}
                  <strong className="text-foreground">Google Drive API</strong>, and{' '}
                  <strong className="text-foreground">Google People API</strong> (for Contacts)
                  under <em>APIs &amp; Services → Library</em>.
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

      {/* Relay settings — self-host URL + connectivity test for the aggregators
          that route through the Compass relay. */}
      <RelaySettings open={relayOpen} onOpenChange={setRelayOpen} />

      {/* Available integrations — searchable + grouped by category so this
          stays scannable as the registry grows well past today's 11. Each
          card shows its own live connect/disconnect state below. */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Available
        </h2>
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="text"
            value={integrationSearch}
            onChange={(e) => setIntegrationSearch(e.target.value)}
            placeholder="Search integrations…"
            aria-label="Search integrations"
            className="text-xs bg-secondary/50 border border-border rounded-lg pl-7 pr-2.5 py-1.5 w-52 focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        <button
          type="button"
          onClick={() => setCategoryFilter('all')}
          aria-pressed={categoryFilter === 'all'}
          className={cn(
            'text-xs px-2.5 py-1 rounded-full border transition-colors',
            categoryFilter === 'all'
              ? 'bg-primary/20 border-primary/40 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
          )}
        >
          All
        </button>
        {INTEGRATION_CATEGORY_ORDER.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategoryFilter(cat)}
            aria-pressed={categoryFilter === cat}
            className={cn(
              'text-xs px-2.5 py-1 rounded-full border transition-colors',
              categoryFilter === cat
                ? 'bg-primary/20 border-primary/40 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
            )}
          >
            {INTEGRATION_CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>
      {availableGroups.length === 0 && (
        <div className="text-sm text-muted-foreground mb-8">
          No integrations match your search.
          {(integrationSearch.trim() || categoryFilter !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setIntegrationSearch('')
                setCategoryFilter('all')
              }}
              className="ml-2 text-primary hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      {availableGroups.map((group) => (
        <div key={group.category} className="mb-6">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">
            {INTEGRATION_CATEGORY_LABELS[group.category]}
          </h3>
          <div className="grid grid-cols-2 gap-4">
            {group.items.map((integration) => {
              const status = statuses[integration.id]
              const state = deriveCardState({
                id: integration.id,
                baseStatus: status?.status,
                baseErrorMessage: status?.errorMessage,
                hasStatusRow: Boolean(status),
                plaidItems,
                simplefinConnections
              })
              const setup = getIntegrationSetup(integration.id)
              const cardError = connectErrors[integration.id] ?? state.errorMessage
              // A persisted, never-connected error (e.g. Things 3 when the app
              // isn't installed) has no other way to clear the red banner short
              // of a successful retry — offer a way out.
              const canDismissError = state.errorWins && !state.isMultiConn && !state.isConnected
              const errorAction =
                setup?.requiresRelay && cardError ? (
                  <span className="space-x-3">
                    <button
                      type="button"
                      onClick={() => setRelayOpen(true)}
                      className="underline hover:text-foreground"
                    >
                      Open Relay settings
                    </button>
                    {canDismissError && (
                      <button
                        type="button"
                        onClick={() => void dismissError(integration.id)}
                        className="underline hover:text-foreground"
                      >
                        Dismiss
                      </button>
                    )}
                  </span>
                ) : canDismissError ? (
                  <button
                    type="button"
                    onClick={() => void dismissError(integration.id)}
                    className="underline hover:text-foreground"
                  >
                    Dismiss
                  </button>
                ) : undefined
              return (
                <IntegrationCard
                  key={integration.id}
                  meta={integration}
                  state={state}
                  lastSyncedAt={status?.lastSyncedAt ?? null}
                  syncIntervalMinutes={status?.syncIntervalMinutes}
                  isSyncing={syncing.has(integration.id)}
                  onSync={() => triggerSync(integration.id)}
                  onChangeInterval={(m) => changeSyncInterval(integration.id, m)}
                  errorMessage={connectErrors[integration.id] ?? undefined}
                  errorAction={errorAction}
                >
                  {renderCardBody(integration, state)}
                </IntegrationCard>
              )
            })}
          </div>
        </div>
      ))}

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

      {/* Coming soon — roadmap integrations with no connect flow yet,
          grouped by category so "what else can I add" scales with the
          registry instead of turning into a flat wall of stub cards. */}
      {comingSoonGroups.length > 0 && (
        <>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Coming Soon
          </h2>
          {comingSoonGroups.map((group) => (
            <div key={group.category} className="mb-6 last:mb-0">
              <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">
                {INTEGRATION_CATEGORY_LABELS[group.category]}
              </h3>
              <div className="grid grid-cols-4 gap-3">
                {group.items.map((i) => (
                  <div
                    key={i.id}
                    className="bg-card border border-border rounded-xl p-4 opacity-60"
                  >
                    <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-sm font-bold text-foreground mb-2">
                      {i.logo}
                    </div>
                    <p className="text-sm font-medium text-foreground">{i.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{i.description}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
