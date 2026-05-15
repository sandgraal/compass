import {
  Bell,
  Bot,
  Database,
  Download,
  Keyboard,
  Monitor,
  Moon,
  RefreshCw,
  Shield,
  Sun,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/Toast'
import { cn } from '../lib/utils'
import { useAppStore } from '../store/appStore'

export default function Settings(): JSX.Element {
  const { theme, setTheme } = useAppStore()
  const [syncInterval, setSyncInterval] = useState('15')
  const [notifications, setNotifications] = useState(true)
  const [contextDrawer, setContextDrawer] = useState(true)
  const { setContextDrawerOpen } = useAppStore()
  const { toast } = useToast()
  const confirm = useConfirm()

  const [appVersion, setAppVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  // Vault auto-lock idle minutes. 0 = disabled. Default mirrors Vault.tsx.
  const [vaultAutoLockMinutes, setVaultAutoLockMinutes] = useState('5')

  // AI assist (Ollama)
  const [ollamaEnabled, setOllamaEnabled] = useState(false)
  const [ollamaModel, setOllamaModel] = useState('')
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [ollamaChecking, setOllamaChecking] = useState(false)
  const loadedOllamaModelRef = useRef<string | null>(null)

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      window.api.settings.getAll().then((s) => {
        const savedModel = s.ollamaModel || ''
        setSyncInterval(s.syncInterval || '15')
        setNotifications(s.notificationsEnabled !== 'false')
        setContextDrawer(s.showContextDrawer !== 'false')
        setOllamaEnabled(s.ollamaSuggestionsEnabled === 'true')
        setOllamaModel(savedModel)
        loadedOllamaModelRef.current = savedModel
        setVaultAutoLockMinutes(s.vaultAutoLockMinutes ?? '5')
        checkOllama({ currentModel: savedModel })
      })
    }
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.api?.updater) {
      window.api.updater
        .getVersion()
        .then(setAppVersion)
        .catch(() => {})
    }
  }, [])

  async function checkOllama(options?: { forceRefresh?: boolean; currentModel?: string }) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    setOllamaChecking(true)
    try {
      const status = await window.api.settings.detectOllama({
        forceRefresh: options?.forceRefresh === true
      })
      setOllamaStatus(status)
      // Auto-select first available model if none set
      const currentModel = options?.currentModel ?? loadedOllamaModelRef.current
      if (status.available && status.models && status.models.length > 0 && !currentModel) {
        const preferred = status.models.find((m) => m.startsWith('llama3.2')) ?? status.models[0]
        setOllamaModel(preferred)
        loadedOllamaModelRef.current = preferred
        await save('ollamaModel', preferred)
      }
    } finally {
      setOllamaChecking(false)
    }
  }

  async function save(key: string, value: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (isElectron) {
      await window.api.settings.set(key, value)
    }
  }

  return (
    <div className="p-8 pt-14 max-w-2xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-semibold text-foreground mb-8">Settings</h1>

      {/* Appearance */}
      <SettingsSection icon={<Sun size={16} />} title="Appearance">
        <SettingsRow label="Theme" description="Choose how Compass looks">
          <div className="flex items-center gap-2">
            {[
              { id: 'light', icon: <Sun size={14} />, label: 'Light' },
              { id: 'dark', icon: <Moon size={14} />, label: 'Dark' },
              { id: 'system', icon: <Monitor size={14} />, label: 'System' }
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  const v =
                    t.id === 'system'
                      ? window.matchMedia('(prefers-color-scheme: dark)').matches
                        ? 'dark'
                        : 'light'
                      : (t.id as 'dark' | 'light')
                  setTheme(v)
                  save('theme', t.id)
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors',
                  t.id === theme || (t.id === 'system' && !['light', 'dark'].includes(theme))
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Context Drawer"
          description="Show the right-side context panel by default"
        >
          <Toggle
            enabled={contextDrawer}
            onChange={(v) => {
              setContextDrawer(v)
              setContextDrawerOpen(v)
              save('showContextDrawer', String(v))
            }}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Sync */}
      <SettingsSection icon={<Database size={16} />} title="Sync">
        <SettingsRow
          label="Auto-sync interval"
          description="How often to pull data from connected services"
        >
          <select
            value={syncInterval}
            onChange={(e) => {
              setSyncInterval(e.target.value)
              save('syncInterval', e.target.value)
            }}
            className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="5">Every 5 minutes</option>
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="0">Manual only</option>
          </select>
        </SettingsRow>
      </SettingsSection>

      {/* Notifications */}
      <SettingsSection icon={<Bell size={16} />} title="Notifications">
        <SettingsRow
          label="Sync notifications"
          description="Show a notification when sync completes"
        >
          <Toggle
            enabled={notifications}
            onChange={(v) => {
              setNotifications(v)
              save('notificationsEnabled', String(v))
            }}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Security */}
      <SettingsSection icon={<Shield size={16} />} title="Security & Privacy">
        <SettingsRow
          label="Data storage"
          description="All data is stored locally in ~/Library/Application Support/Compass"
        >
          <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
            Local only
          </span>
        </SettingsRow>
        <SettingsRow
          label="Vault encryption"
          description="Sensitive data encrypted with AES-256-GCM, key in OS Keychain"
        >
          <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
            AES-256-GCM
          </span>
        </SettingsRow>
        <SettingsRow
          label="Vault auto-lock"
          description="Hide vault entries behind an Unlock CTA after this many idle minutes. Also locks immediately on window focus loss. Applies on next visit to /vault."
        >
          <select
            value={vaultAutoLockMinutes}
            onChange={(e) => {
              setVaultAutoLockMinutes(e.target.value)
              save('vaultAutoLockMinutes', e.target.value)
            }}
            aria-label="Vault auto-lock idle minutes"
            className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="0">Off</option>
            <option value="1">After 1 minute</option>
            <option value="2">After 2 minutes</option>
            <option value="5">After 5 minutes</option>
            <option value="10">After 10 minutes</option>
            <option value="15">After 15 minutes</option>
            <option value="30">After 30 minutes</option>
            <option value="60">After 1 hour</option>
          </select>
        </SettingsRow>
      </SettingsSection>

      {/* Data */}
      <SettingsSection icon={<Download size={16} />} title="Data">
        <SettingsRow
          label="Open data folder"
          description="Browse your local knowledge base, vault, and database files in Finder"
        >
          <button
            onClick={() => window.api?.settings.openDataDir()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Database size={12} /> Open in Finder
          </button>
        </SettingsRow>
        <SettingsRow
          label="Export data"
          description="Save all your data (tasks, habits, finance, knowledge index) as a JSON file"
        >
          <button
            onClick={async () => {
              const r = await window.api?.settings.exportData()
              if (r?.success) toast(`Exported to: ${r.path}`, 'success')
              else if (!r?.canceled) toast(`Export failed: ${r?.error}`, 'error')
            }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
          >
            <Download size={12} /> Export JSON
          </button>
        </SettingsRow>
      </SettingsSection>

      {/* Quick Capture */}
      <SettingsSection icon={<Keyboard size={16} />} title="Quick Capture">
        <SettingsRow
          label="Global shortcut"
          description="Press this from anywhere in macOS to open the capture popover."
        >
          <ShortcutRecorder />
        </SettingsRow>
      </SettingsSection>

      {/* AI Assist (Ollama) */}
      <SettingsSection icon={<Bot size={16} />} title="AI assist (optional)">
        <SettingsRow
          label="Use local Ollama for knowledge suggestions"
          description="Opt-in only. Ollama runs entirely on your machine — no data leaves your device."
        >
          <Toggle
            enabled={ollamaEnabled}
            onChange={(v) => {
              setOllamaEnabled(v)
              save('ollamaSuggestionsEnabled', String(v))
            }}
          />
        </SettingsRow>

        {/* Ollama status row */}
        <SettingsRow
          label="Ollama status"
          description={
            ollamaChecking
              ? 'Checking…'
              : ollamaStatus?.available
                ? `Running — ${ollamaStatus.models?.length ?? 0} model(s) available`
                : 'Not detected'
          }
        >
          <div className="flex items-center gap-2">
            {ollamaChecking ? (
              <span className="text-xs text-muted-foreground px-2 py-1 rounded-full bg-secondary">
                Checking…
              </span>
            ) : ollamaStatus?.available ? (
              <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
                Running
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="text-xs bg-secondary px-2 py-1 rounded-full">Not running</span>
                <a
                  href="https://ollama.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary underline underline-offset-2"
                  aria-label="Install Ollama (opens ollama.ai in browser)"
                >
                  Install
                </a>
              </span>
            )}
            <button
              onClick={() => checkOllama({ forceRefresh: true })}
              disabled={ollamaChecking}
              aria-label="Re-check Ollama status"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary rounded disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </SettingsRow>

        {/* Model selector — only shown when Ollama is available */}
        {ollamaStatus?.available && (ollamaStatus.models?.length ?? 0) > 0 && (
          <SettingsRow
            label="Model"
            description="Which Ollama model to use for suggestion extraction"
          >
            <select
              value={ollamaModel}
              onChange={(e) => {
                setOllamaModel(e.target.value)
                loadedOllamaModelRef.current = e.target.value
                save('ollamaModel', e.target.value)
              }}
              aria-label="Select Ollama model"
              className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {ollamaStatus.models?.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection icon={<RefreshCw size={16} />} title="Updates">
        <SettingsRow
          label="Check for updates"
          description={appVersion ? `Current version: ${appVersion}` : 'Checking version…'}
        >
          <button
            type="button"
            disabled={checkingUpdate}
            aria-label="Check for updates now"
            onClick={async () => {
              setCheckingUpdate(true)
              try {
                const result = await window.api.updater.check()
                if (!result.success) {
                  toast(result.error ?? 'Update check failed', 'error')
                }
              } finally {
                setCheckingUpdate(false)
              }
            }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={checkingUpdate ? 'animate-spin' : ''} />
            {checkingUpdate ? 'Checking…' : 'Check now'}
          </button>
        </SettingsRow>
      </SettingsSection>

      {/* Danger zone */}
      <div className="border border-destructive/30 rounded-xl p-5 bg-destructive/5">
        <h3 className="text-sm font-semibold text-destructive mb-1 flex items-center gap-2">
          <Trash2 size={14} /> Danger Zone
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          These actions are permanent and cannot be undone.
        </p>
        <div className="space-y-3">
          <SettingsRow
            label="Wipe knowledge base"
            description="Delete all files in your local knowledge-base folder"
          >
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: 'Wipe knowledge base?',
                  description:
                    'Delete all files in your local knowledge-base folder. This cannot be undone.',
                  confirmLabel: 'Wipe',
                  destructive: true
                })
                if (!ok) return
                const r = await window.api?.settings.wipeKnowledge()
                if (r?.success) toast('Knowledge base wiped.', 'success')
                else toast(`Error: ${r?.error}`, 'error')
              }}
              className="text-xs px-3 py-1.5 border border-destructive/50 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
            >
              Wipe
            </button>
          </SettingsRow>
          <SettingsRow
            label="Wipe vault"
            description="Delete all encrypted vault data (.enc files). Cannot be recovered."
          >
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: 'Wipe vault?',
                  description:
                    'Delete all encrypted vault data (.enc files). All entries will be permanently lost and cannot be recovered.',
                  confirmLabel: 'Wipe vault',
                  destructive: true
                })
                if (!ok) return
                const r = await window.api?.settings.wipeVault()
                if (r?.success) toast('Vault wiped.', 'success')
                else toast(`Error: ${r?.error}`, 'error')
              }}
              className="text-xs px-3 py-1.5 border border-destructive/50 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
            >
              Wipe vault
            </button>
          </SettingsRow>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({
  icon,
  title,
  children
}: { icon: React.ReactNode; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
        {icon} {title}
      </h2>
      <div className="bg-card border border-border rounded-xl divide-y divide-border">
        {children}
      </div>
    </div>
  )
}

function SettingsRow({
  label,
  description,
  children
}: { label: string; description: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <p className="text-sm text-foreground font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="ml-4 shrink-0">{children}</div>
    </div>
  )
}

function Toggle({
  enabled,
  onChange
}: { enabled: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={cn(
        'w-10 h-5 rounded-full transition-colors relative',
        enabled ? 'bg-primary' : 'bg-secondary'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
          enabled ? 'translate-x-5' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Shortcut recorder helpers
// ---------------------------------------------------------------------------

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

/** Map a KeyboardEvent to canonical Electron accelerator modifier tokens. */
function eventModifiers(e: KeyboardEvent): string[] {
  const mods: string[] = []
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return mods
}

/** Map a KeyboardEvent.key to an Electron accelerator key token. */
function electronKey(e: KeyboardEvent): string | null {
  const { key, code } = e
  // Ignore bare modifier presses
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null
  // Space
  if (key === ' ') return 'Space'
  // Function keys
  if (/^F\d+$/.test(key)) return key
  // Named keys
  const named: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Escape: 'Escape',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert'
  }
  if (named[key]) return named[key]

  // Printable keys via code to avoid shifted symbols producing invalid
  // accelerator tokens (for example Shift+= yielding '+' instead of '=').
  if (/^Digit(\d)$/.test(code)) return code.replace('Digit', '')
  if (/^Key([A-Z])$/.test(code)) return code.replace('Key', '')

  const printableByCode: Record<string, string> = {
    Equal: '=',
    Minus: '-',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  }
  if (printableByCode[code]) return printableByCode[code]

  // Fall back only for single alphanumeric characters; avoid punctuation
  // such as '+' because Electron uses '+' as the accelerator separator.
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase()
  return null
}

/** Convert an Electron accelerator string to macOS display glyphs. */
function acceleratorToDisplay(acc: string): string {
  return acc
    .split('+')
    .map((part) => {
      switch (part) {
        case 'CommandOrControl':
        case 'CmdOrCtrl':
        case 'Command':
        case 'Cmd':
          return '⌘'
        case 'Control':
        case 'Ctrl':
          return '⌃'
        case 'Alt':
        case 'Option':
          return '⌥'
        case 'Shift':
          return '⇧'
        case 'Space':
          return 'Space'
        default:
          return part
      }
    })
    .join(' ')
}

// ---------------------------------------------------------------------------
// ShortcutRecorder component
// ---------------------------------------------------------------------------

function ShortcutRecorder(): JSX.Element {
  const [shortcut, setShortcut] = useState(DEFAULT_SHORTCUT)
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { toast } = useToast()

  // Load persisted shortcut on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.api) {
      window.api.settings.get('quickCaptureShortcut').then((v) => {
        if (v) setShortcut(v)
      })
    }
  }, [])

  function startRecording() {
    setRecording(true)
  }

  function cancelRecording() {
    setRecording(false)
  }

  async function applyShortcut(accelerator: string) {
    setRecording(false)
    setSaving(true)
    try {
      const r = await window.api?.settings.setQuickCaptureShortcut(accelerator)
      if (r?.success) {
        setShortcut(accelerator)
        toast('Shortcut updated.', 'success')
      } else {
        toast(r?.error ?? 'Failed to register shortcut.', 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  async function resetToDefault() {
    await applyShortcut(DEFAULT_SHORTCUT)
  }

  // Capture keydown while in recording mode
  useEffect(() => {
    if (!recording) return

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        cancelRecording()
        return
      }

      const key = electronKey(e)
      if (!key) return // bare modifier — keep waiting

      const mods = eventModifiers(e)
      if (mods.length === 0) return // require at least one modifier

      const accelerator = [...mods, key].join('+')
      void applyShortcut(accelerator)
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [recording]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex items-center gap-2">
      <button
        ref={buttonRef}
        onClick={recording ? cancelRecording : startRecording}
        disabled={saving}
        aria-label={recording ? 'Cancel shortcut recording' : 'Record new shortcut'}
        className={cn(
          'min-w-[120px] px-3 py-1.5 text-xs rounded-lg border transition-colors font-mono',
          'focus:outline-none focus:ring-1 focus:ring-primary',
          recording
            ? 'border-primary bg-primary/10 text-primary animate-pulse'
            : 'border-border bg-secondary text-foreground hover:border-primary/50',
          saving && 'opacity-50 cursor-not-allowed'
        )}
      >
        {saving ? 'Saving…' : recording ? 'Press keys…' : acceleratorToDisplay(shortcut)}
      </button>
      {!recording && !saving && shortcut !== DEFAULT_SHORTCUT && (
        <button
          onClick={resetToDefault}
          aria-label="Reset shortcut to default"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary rounded"
        >
          Reset
        </button>
      )}
    </div>
  )
}
