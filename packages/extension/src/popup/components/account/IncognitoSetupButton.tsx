import { useLayoutEffect, useRef, useState } from 'react'
import incognitoWatermark from '@/images/figma-incognito-watermark.svg'
import { cn } from '@/lib/utils'
import { InlineError } from '../common/InlineError'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

export function IncognitoSetupButton({
  className,
  disabled,
  complete,
  onAddEvmNetwork,
  onOpen,
  onCompleted
}: {
  readonly className?: string
  readonly disabled?: boolean
  readonly complete?: () => Promise<boolean>
  readonly onAddEvmNetwork?: () => void
  readonly onOpen?: () => void
  readonly onCompleted?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function create() {
    if (pending.current || disabled || !complete) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if ((await complete()) && mounted.current) {
        setOpen(false)
        onCompleted?.()
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : 'Unable to enable Incognito.')
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Enable Incognito"
        aria-haspopup={onAddEvmNetwork ? undefined : 'dialog'}
        disabled={disabled}
        onClick={() => {
          onOpen?.()
          if (onAddEvmNetwork) {
            onAddEvmNetwork()
            return
          }
          setError(null)
          setOpen(true)
        }}
        className={cn(
          'wallet-interactive min-h-8 shrink-0 whitespace-nowrap rounded-md border border-dashed border-current/35 px-3 text-sm hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50',
          className
        )}
      >
        + Incognito
      </button>
      <Dialog
        open={open && !disabled}
        onOpenChange={visible => !pending.current && setOpen(visible)}
      >
        <DialogContent
          position="bottom"
          overlayClassName="bg-black/55 backdrop-blur-none"
          className="home-wallet-sheet h-[70dvh] gap-4 rounded-t-[20px] px-4 pt-4 pb-6"
          onCloseAutoFocus={event => {
            if (!trigger.current) return
            event.preventDefault()
            trigger.current.focus()
          }}
        >
          <DialogTitle className="pr-10 text-lg font-medium">+ Incognito</DialogTitle>
          <div className="mx-3 mt-3 space-y-4 text-center">
            <div
              data-balance-domain="private"
              data-expanded="true"
              aria-hidden="true"
              className="home-balance-card home-balance-preview relative isolate h-[140px] overflow-hidden rounded-xl p-3.5 text-left"
            >
              <div className="flex justify-between gap-2 text-sm">
                <span>Incognito</span>
                <span className="text-lg font-semibold">$••••</span>
              </div>
              <img className="mt-4 size-[70px] opacity-35" src={incognitoWatermark} alt="" />
            </div>
            <DialogDescription className="px-3 pt-3 leading-[18px] text-wallet-secondary">
              Use a separate address for DeFi. Your existing recovery phrase backs up this wallet
              too.
            </DialogDescription>
            {error && <InlineError message={error} />}
            <Button
              size="wallet"
              className="mt-4 w-[94%]"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create Now'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
