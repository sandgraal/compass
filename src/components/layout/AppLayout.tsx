import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store/appStore'
import { OnboardingWizard } from '../onboarding/OnboardingWizard'
import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { ToastProvider } from '../ui/Toast'
import { UpdateBanner } from '../ui/UpdateBanner'
import { ContextDrawer } from './ContextDrawer'
import { Sidebar } from './Sidebar'

const ONBOARDING_COMPLETED_KEY = 'onboardingCompleted'
const LEGACY_ONBOARDING_COMPLETED_KEY = 'onboardingComplete'

export function AppLayout(): JSX.Element {
  const { contextDrawerOpen } = useAppStore()
  // null = not yet loaded; true = show wizard; false = hidden
  const [showWizard, setShowWizard] = useState<boolean | null>(null)

  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && !!window.api
    if (!isElectron) {
      setShowWizard(false)
      return
    }
    Promise.all([
      window.api.settings.get(ONBOARDING_COMPLETED_KEY),
      window.api.settings.get(LEGACY_ONBOARDING_COMPLETED_KEY)
    ])
      .then(([value, legacyValue]) => {
        // Show wizard only when neither key is set to 'true'
        setShowWizard(value !== 'true' && legacyValue !== 'true')
      })
      .catch(() => {
        setShowWizard(false)
      })
  }, [])

  function handleWizardComplete() {
    setShowWizard(false)
  }

  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <div className="flex h-screen w-screen overflow-hidden bg-background">
          {/* macOS title bar spacer */}
          <div className="fixed top-0 left-0 right-0 h-10 titlebar-drag z-50 pointer-events-none" />

          {/* Left sidebar */}
          <Sidebar />

          {/* Main content area */}
          <main
            className={cn(
              'flex-1 flex flex-col overflow-hidden transition-all duration-200',
              contextDrawerOpen ? 'mr-80' : 'mr-0'
            )}
          >
            <UpdateBanner />
            <div className="flex-1 overflow-y-auto">
              <Outlet />
            </div>
          </main>

          {/* Right context drawer */}
          <ContextDrawer />

          {/* Onboarding wizard — shown once on first launch */}
          {showWizard === true && <OnboardingWizard onComplete={handleWizardComplete} />}
        </div>
      </ConfirmDialogProvider>
    </ToastProvider>
  )
}
