import * as RadixToast from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  message: string
  type: ToastType
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counterRef = useRef(0)

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    counterRef.current += 1
    const id = String(counterRef.current)
    setToasts((prev) => [...prev, { id, message, type }])
  }, [])

  function dismiss(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  return (
    <ToastContext.Provider value={{ toast }}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <RadixToast.Root
            key={t.id}
            open
            onOpenChange={(open) => {
              if (!open) dismiss(t.id)
            }}
            duration={4000}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            className={cn(
              'flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium',
              'data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out',
              t.type === 'success' && 'bg-emerald-500/90 text-white',
              t.type === 'error' && 'bg-destructive/90 text-destructive-foreground',
              t.type === 'info' && 'bg-secondary text-foreground border border-border'
            )}
          >
            <RadixToast.Description className="flex-1">{t.message}</RadixToast.Description>
            <RadixToast.Action altText="Close notification" asChild>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Close notification"
                className="ml-1 opacity-70 hover:opacity-100 transition-opacity"
              >
                <X size={14} />
              </button>
            </RadixToast.Action>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-auto max-w-sm focus:outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
