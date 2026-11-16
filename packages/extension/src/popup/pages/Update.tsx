import { useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog'
import { useExtensionUpdate } from '../hooks/useExtensionUpdate'
import { useLocation, useNavigate } from '../provider/Router'

async function closeCurrentTab(): Promise<boolean> {
  try {
    const tab = await chrome.tabs.getCurrent()
    if (tab?.id === undefined) return false
    await chrome.tabs.remove(tab.id)
    return true
  } catch {
    return false
  }
}

export function UpdatePage() {
  const { state, isLoading, applyUpdate } = useExtensionUpdate()
  const { navigate } = useNavigate()
  const location = useLocation()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const leavePage = async () => {
    const openedFromWallet = new URLSearchParams(location.search).get('from') === 'wallet'
    if (openedFromWallet) {
      navigate('/')
      return
    }

    if (!(await closeCurrentTab())) {
      window.close()
    }
  }

  const handleUpdate = async () => {
    if (state?.status !== 'available') return
    setIsSubmitting(true)
    setError(null)
    try {
      await applyUpdate(state.version)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'The update could not start.')
      setIsSubmitting(false)
    }
  }

  const handleDone = async () => {
    setIsSubmitting(true)
    setError(null)
    try {
      await leavePage()
    } catch (closeError) {
      setError(
        closeError instanceof Error ? closeError.message : 'The update page could not close.'
      )
      setIsSubmitting(false)
    }
  }

  return (
    <div className="page-container bg-background">
      {isLoading ? (
        <div
          role="status"
          aria-label="Loading update information"
          className="flex h-full items-center justify-center px-5"
        >
          <div className="w-full max-w-[335px] space-y-4 rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-col items-center gap-3">
              <Skeleton className="size-10 rounded-full" />
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-12 rounded-lg" />
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-10 rounded-lg" />
              <Skeleton className="h-10 rounded-lg" />
            </div>
          </div>
        </div>
      ) : (
        <Dialog open>
          <DialogContent
            showCloseButton={false}
            onOpenAutoFocus={event => event.preventDefault()}
            className="max-w-[335px] gap-0 rounded-2xl border border-border bg-card p-5"
          >
            {state?.status === 'available' ? (
              <>
                <DialogHeader className="items-center text-center">
                  <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Icon icon="lucide:download" width={20} />
                  </div>
                  <DialogTitle>Update available</DialogTitle>
                  <DialogDescription className="leading-relaxed text-muted">
                    Version {state.version} is ready.
                  </DialogDescription>
                </DialogHeader>

                <div className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-warning">
                  <Icon icon="lucide:info" width={14} className="mt-0.5 shrink-0 text-warning" />
                  <p>Finish any transaction before restarting.</p>
                </div>

                {error && (
                  <div
                    role="alert"
                    className="mt-3 rounded-lg bg-danger/10 p-3 text-xs text-danger"
                  >
                    {error}
                  </div>
                )}

                <div className="mt-5 flex gap-2">
                  <Button variant="outline" className="h-10 flex-1" onClick={leavePage}>
                    Later
                  </Button>
                  <Button className="h-10 flex-1" isLoading={isSubmitting} onClick={handleUpdate}>
                    Restart
                  </Button>
                </div>
              </>
            ) : (
              <>
                <DialogHeader className="items-center text-center">
                  <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Icon icon="lucide:check" width={20} />
                  </div>
                  <DialogTitle>Noir Wallet is up to date</DialogTitle>
                  <DialogDescription className="text-muted">
                    You’re using version {__APP_VERSION__}.
                  </DialogDescription>
                </DialogHeader>

                {error && (
                  <div
                    role="alert"
                    className="mt-3 rounded-lg bg-danger/10 p-3 text-xs text-danger"
                  >
                    {error}
                  </div>
                )}

                <Button className="mt-5 h-10 w-full" isLoading={isSubmitting} onClick={handleDone}>
                  Got it
                </Button>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
