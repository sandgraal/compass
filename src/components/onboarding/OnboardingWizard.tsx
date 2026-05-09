import { CheckCircle2, FolderOpen, Lock, Plug2, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { useToast } from '../ui/Toast'

const TOTAL_STEPS = 4
const STEP_KEYS = ['welcome', 'integrations', 'finance', 'vault'] as const
const ONBOARDING_COMPLETED_KEY = 'onboardingCompleted'

interface OnboardingWizardProps {
  onComplete: () => void
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps): JSX.Element {
  const [step, setStep] = useState(1)
  const [animating, setAnimating] = useState(false)
  const transitionTimeoutRef = useRef<number | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current)
      }
    }
  }, [])

  function goTo(next: number) {
    if (animating) return
    setAnimating(true)
    if (transitionTimeoutRef.current !== null) {
      window.clearTimeout(transitionTimeoutRef.current)
    }
    transitionTimeoutRef.current = window.setTimeout(() => {
      setStep(next)
      setAnimating(false)
      transitionTimeoutRef.current = null
    }, 150)
  }

  const finish = useCallback(async () => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    try {
      if (isElectron) {
        await window.api.settings.set(ONBOARDING_COMPLETED_KEY, 'true')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast(`Could not save onboarding status: ${message}`, 'error')
    } finally {
      onComplete()
    }
  }, [onComplete, toast])

  function advance() {
    if (step < TOTAL_STEPS) {
      goTo(step + 1)
    } else {
      void finish()
    }
  }

  function back() {
    if (step > 1) goTo(step - 1)
  }

  // Esc closes and marks onboarding complete
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        void finish()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [finish])

  return (
    <dialog
      open
      className="fixed inset-0 z-50 m-0 h-full w-full max-w-none bg-black/70 flex items-center justify-center animate-fade-in border-none p-0"
      aria-label="Welcome to Compass — onboarding wizard"
    >
      <div
        className={cn(
          'w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden',
          'transition-opacity duration-150',
          animating ? 'opacity-0' : 'opacity-100'
        )}
      >
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 pt-6 pb-2">
          {STEP_KEYS.map((key, i) => (
            <span
              key={key}
              className={cn(
                'block rounded-full transition-all duration-200',
                i + 1 === step
                  ? 'w-5 h-1.5 bg-primary'
                  : i + 1 < step
                    ? 'w-1.5 h-1.5 bg-primary/40'
                    : 'w-1.5 h-1.5 bg-border'
              )}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="px-8 py-6">
          {step === 1 && <StepWelcome onNext={advance} onSkip={() => void finish()} />}
          {step === 2 && (
            <StepIntegrations onNext={advance} onBack={back} onSkip={() => void finish()} />
          )}
          {step === 3 && (
            <StepFinance onNext={advance} onBack={back} onSkip={() => void finish()} />
          )}
          {step === 4 && <StepVault onFinish={() => void finish()} onBack={back} />}
        </div>
      </div>
    </dialog>
  )
}

// ─── Step 1: Welcome ──────────────────────────────────────────────────────────

function StepWelcome({
  onNext,
  onSkip
}: {
  onNext: () => void
  onSkip: () => void
}): JSX.Element {
  return (
    <div className="text-center animate-fade-in">
      <div className="text-5xl mb-5 select-none" role="img" aria-label="Compass">
        🧭
      </div>
      <h1 className="text-2xl font-semibold text-foreground mb-3">Welcome to Compass</h1>
      <p className="text-sm text-muted-foreground leading-relaxed mb-8">
        Your local-first life planner. Everything stays on this Mac. Nothing is synced to a server
        unless you connect a service.
      </p>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onNext}
          className="w-full px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
        >
          Get started
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Skip setup
        </button>
      </div>
    </div>
  )
}

// ─── Step 2: Integrations ─────────────────────────────────────────────────────

const INTEGRATIONS_CONFIG = [
  {
    id: 'google',
    name: 'Google',
    description: 'Calendar, Gmail actions, and Drive index',
    logo: 'G',
    color: 'from-red-500/20 to-yellow-500/20'
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, PRs, and project board items',
    logo: '⌥',
    color: 'from-gray-500/20 to-gray-700/20'
  }
] as const

function StepIntegrations({
  onNext,
  onBack,
  onSkip
}: {
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}): JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    window.api.auth
      .getStatus()
      .then((rows) => {
        const map: Record<string, string> = {}
        for (const r of rows) map[r.service] = r.status
        setStatuses(map)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        toast(`Failed to load connection status: ${message}`, 'error')
      })
  }, [toast])

  async function connect(service: string) {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    setConnecting(service)
    try {
      const result =
        service === 'google'
          ? await window.api.auth.connectGoogle()
          : await window.api.auth.connectGitHub()
      if (result.error) {
        toast(`Connection failed: ${result.error}`, 'error')
      } else {
        const rows = await window.api.auth.getStatus()
        const map: Record<string, string> = {}
        for (const r of rows) map[r.service] = r.status
        setStatuses(map)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast(`Connection failed: ${message}`, 'error')
    } finally {
      setConnecting(null)
    }
  }

  return (
    <div className="animate-fade-in">
      <h2 className="text-xl font-semibold text-foreground mb-1">Connect integrations</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Pull in calendar, email actions, and GitHub items automatically. Skip and connect later if
        you haven't set up OAuth credentials yet.
      </p>

      <div className="space-y-3 mb-6">
        {INTEGRATIONS_CONFIG.map((integration) => {
          const isConnected = statuses[integration.id] === 'connected'
          const isConnecting = connecting === integration.id

          return (
            <div
              key={integration.id}
              className={cn(
                'flex items-center gap-4 p-4 bg-gradient-to-r border border-border rounded-xl',
                integration.color
              )}
            >
              <div className="w-10 h-10 rounded-xl bg-background/60 flex items-center justify-center text-lg font-bold text-foreground shrink-0">
                {integration.logo}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{integration.name}</p>
                <p className="text-xs text-muted-foreground">{integration.description}</p>
              </div>
              <div className="shrink-0">
                {isConnected ? (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 size={13} /> Connected
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connect(integration.id)}
                    disabled={isConnecting}
                    aria-label={`Connect ${integration.name}`}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <Plug2 size={11} />
                    {isConnecting ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel="Next"
        skipLabel="Skip — I'll do this later"
        onSkip={onSkip}
        showBack
      />
    </div>
  )
}

// ─── Step 3: Finance ──────────────────────────────────────────────────────────

function StepFinance({
  onNext,
  onBack,
  onSkip
}: {
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}): JSX.Element {
  const [watchFolder, setWatchFolderState] = useState<{
    path: string
    isWatching: boolean
    exists: boolean
  } | null>(null)
  const [picking, setPicking] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    window.api.finance.getWatchFolder().then(setWatchFolderState)
  }, [])

  async function pickFolder() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    setPicking(true)
    try {
      const r = await window.api.finance.pickWatchFolder()
      if (!r.canceled) {
        const status = await window.api.finance.getWatchFolder()
        setWatchFolderState(status)
        toast('Watch folder updated.', 'success')
      }
    } catch {
      toast('Could not update watch folder.', 'error')
    } finally {
      setPicking(false)
    }
  }

  async function useDefault() {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) return
    try {
      await window.api.finance.setWatchFolder(null)
      const status = await window.api.finance.getWatchFolder()
      setWatchFolderState(status)
      toast('Using default watch folder.', 'success')
    } catch {
      toast('Could not set default folder.', 'error')
    }
  }

  return (
    <div className="animate-fade-in">
      <h2 className="text-xl font-semibold text-foreground mb-1">Track your money automatically</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Drop bank statements (CSV or AMEX xlsx) into a folder we watch. We'll process them and never
        touch the originals.
      </p>

      <div className="bg-secondary/50 border border-border rounded-xl p-4 mb-4">
        <p className="text-xs text-muted-foreground mb-1">Current watch folder</p>
        {watchFolder ? (
          <p className="text-sm text-foreground font-mono break-all" title={watchFolder.path}>
            {watchFolder.path}
          </p>
        ) : (
          <div className="h-4 w-3/4 bg-secondary rounded animate-pulse" />
        )}
        {watchFolder && !watchFolder.exists && (
          <p className="text-xs text-amber-400 mt-1">
            Folder not found — it will be created when you drop files.
          </p>
        )}
      </div>

      <div className="flex gap-2 mb-6">
        <button
          type="button"
          onClick={() => void pickFolder()}
          disabled={picking}
          className="flex items-center gap-1.5 text-xs px-3 py-2 bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <FolderOpen size={13} />
          {picking ? 'Picking…' : 'Pick folder'}
        </button>
        <button
          type="button"
          onClick={() => void useDefault()}
          className="flex items-center gap-1.5 text-xs px-3 py-2 bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
        >
          Use default ~/Documents/Money
        </button>
      </div>

      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextLabel="Next"
        skipLabel="Skip"
        onSkip={onSkip}
        showBack
      />
    </div>
  )
}

// ─── Step 4: Vault primer ────────────────────────────────────────────────────

function StepVault({
  onFinish,
  onBack
}: {
  onFinish: () => void
  onBack: () => void
}): JSX.Element {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Lock size={18} className="text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">
          Your sensitive stuff stays encrypted
        </h2>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
        Bank logins, passwords, IDs — all AES-256 encrypted with a key in your macOS Keychain. Open{' '}
        <span className="text-foreground font-medium">Vault → Financial</span> later to fill in
        details.
      </p>

      <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3 mb-6">
        <ShieldCheck size={14} className="text-emerald-400 shrink-0" />
        <div>
          <p className="text-xs font-medium text-emerald-400">AES-256-GCM encryption</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Key lives in OS Keychain — never on disk in plain text
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary rounded-lg"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onFinish}
          className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
        >
          Got it — open Compass
        </button>
      </div>
    </div>
  )
}

// ─── Shared nav row ───────────────────────────────────────────────────────────

function StepNav({
  onBack,
  onNext,
  nextLabel,
  skipLabel,
  onSkip,
  showBack
}: {
  onBack?: () => void
  onNext: () => void
  nextLabel: string
  skipLabel: string
  onSkip: () => void
  showBack?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {showBack && (
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary rounded-lg"
        >
          Back
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {nextLabel}
      </button>
      <button
        type="button"
        onClick={onSkip}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2"
      >
        {skipLabel}
      </button>
    </div>
  )
}
