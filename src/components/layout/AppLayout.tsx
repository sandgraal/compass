import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store/appStore'
import { CommandPalette } from '../ui/CommandPalette'
import { ContextDrawer } from './ContextDrawer'
import { Sidebar } from './Sidebar'

export function AppLayout(): JSX.Element {
  const { contextDrawerOpen } = useAppStore()
  const [cmdOpen, setCmdOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
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
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      {/* Right context drawer */}
      <ContextDrawer />

      {/* Global ⌘K command palette */}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  )
}
