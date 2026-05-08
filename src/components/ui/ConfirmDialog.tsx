import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

interface ConfirmOptions {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmDialogContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const previousResolve = resolveRef.current
      if (previousResolve) {
        resolveRef.current = null
        previousResolve(false)
      }

      resolveRef.current = resolve
      setPending({ options, resolve })
    })
  }, [])

  function handleConfirm() {
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(true)
    setPending(null)
  }

  function handleCancel() {
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(false)
    setPending(null)
  }

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) handleCancel()
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in" />
          <AlertDialog.Content
            className={cn(
              'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
              'w-full max-w-md bg-card border border-border rounded-xl p-6 shadow-xl',
              'data-[state=open]:animate-fade-in focus:outline-none'
            )}
          >
            {pending && (
              <>
                <AlertDialog.Title className="text-base font-semibold text-foreground mb-2">
                  {pending.options.title}
                </AlertDialog.Title>
                <AlertDialog.Description className="text-sm text-muted-foreground mb-6">
                  {pending.options.description}
                </AlertDialog.Description>
                <div className="flex gap-3 justify-end">
                  <AlertDialog.Cancel asChild>
                    <button
                      type="button"
                      onClick={handleCancel}
                      className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg"
                    >
                      {pending.options.cancelLabel ?? 'Cancel'}
                    </button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button
                      type="button"
                      onClick={handleConfirm}
                      className={cn(
                        'px-4 py-2 text-sm rounded-lg font-medium transition-colors',
                        pending.options.destructive
                          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      )}
                    >
                      {pending.options.confirmLabel ?? 'Confirm'}
                    </button>
                  </AlertDialog.Action>
                </div>
              </>
            )}
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmDialogContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmDialogContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmDialogProvider')
  return ctx
}
