import { useState, useCallback, useRef, useContext, createContext, useEffect } from 'react'
import { didCredentialSessionEnd } from '@/core/wallet/credential-session-state'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../components/ui/dialog'

// ── Types ────────────────────────────────────────────────────────────────────

export interface DialogOptions {
  title?: string
  message: string
  confirmText?: string
  /** Pass empty string '' to hide the Cancel button (alert / notice mode) */
  cancelText?: string
  variant?: 'default' | 'danger'
}

type DialogFn = (options: DialogOptions) => Promise<boolean>

interface DialogContextValue {
  confirm: (
    options: Omit<DialogOptions, 'cancelText'> & { cancelText?: string }
  ) => Promise<boolean>
  alert: (options: Omit<DialogOptions, 'cancelText' | 'confirmText'>) => Promise<void>
}

// ── Context ───────────────────────────────────────────────────────────────────

const DialogContext = createContext<DialogContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────────

interface DialogState extends DialogOptions {
  open: boolean
}

/**
 * Mount once near the root of the app.
 * After that, any component can call useDialog() to get confirm/alert.
 *
 * <DialogProvider>
 *   <App />
 * </DialogProvider>
 */
export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>({ open: false, message: '' })
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const openDialog = useCallback<DialogFn>(options => {
    return new Promise(resolve => {
      resolveRef.current = resolve
      setState({ ...options, open: true })
    })
  }, [])

  const handleConfirm = useCallback(() => {
    setState(s => ({ ...s, open: false }))
    resolveRef.current?.(true)
    resolveRef.current = null
  }, [])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, open: false }))
    resolveRef.current?.(false)
    resolveRef.current = null
  }, [])

  useEffect(() => {
    const handleSessionChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (didCredentialSessionEnd(changes, areaName)) handleCancel()
    }
    chrome.storage.onChanged.addListener(handleSessionChange)
    return () => chrome.storage.onChanged.removeListener(handleSessionChange)
  }, [handleCancel])

  const confirm = useCallback<DialogContextValue['confirm']>(
    options => openDialog({ cancelText: 'Cancel', ...options }),
    [openDialog]
  )

  const alert = useCallback<DialogContextValue['alert']>(
    async options => {
      await openDialog({ ...options, cancelText: '', confirmText: 'OK', variant: 'default' })
    },
    [openDialog]
  )

  const isDanger = state.variant === 'danger'
  const showCancel = state.cancelText !== ''

  return (
    <DialogContext.Provider value={{ confirm, alert }}>
      {children}
      <Dialog
        open={state.open}
        onOpenChange={open => {
          if (!open) handleCancel()
        }}
      >
        <DialogContent showCloseButton={false} position="bottom">
          <DialogHeader>
            {state.title && <DialogTitle>{state.title}</DialogTitle>}
            <DialogDescription className="text-foreground/80 text-sm">
              {state.message}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mt-2">
            {showCancel && (
              <Button variant="outline" className="flex-1 h-11" onClick={handleCancel}>
                {state.cancelText || 'Cancel'}
              </Button>
            )}
            <Button
              className={`flex-1 h-11 ${isDanger ? 'bg-danger hover:bg-danger/90 text-white' : ''}`}
              onClick={handleConfirm}
            >
              {state.confirmText || 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DialogContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Call anywhere inside <DialogProvider> to get confirm/alert functions.
 *
 * const { confirm, alert } = useDialog()
 * if (await confirm({ message: 'Delete this?' })) { ... }
 * await alert({ title: 'Notice', message: 'Cannot proceed.' })
 */
export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>')
  return ctx
}
