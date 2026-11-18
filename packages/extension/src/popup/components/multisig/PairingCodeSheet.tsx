import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import type { MultisigDevice } from '@/core/multisig/types'
import { Button } from '@/popup/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import { Pill } from './Pill'

const CODE_LENGTH = 6

/**
 * 'enter': the user types the code shown here into the phone (simulated phones).
 * 'compare': both screens show the same code and the user confirms they match (real Bluetooth).
 * 'waiting': the match is confirmed and the phone is being asked to join.
 */
export type PairingCodeMode = 'enter' | 'compare' | 'waiting'

interface PairingCodeSheetProps {
  open: boolean
  mode?: PairingCodeMode
  onConfirm?: () => void
  device: MultisigDevice | null
  code: string | null
  expiresAt: number | null
  error: 'wrong' | 'expired' | null
  success: boolean
  onResend: () => void
  onCancel: () => void
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Current time that re-renders once per second while `active`; the interval dies with the effect. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    // Catch up immediately: `now` may be stale from before the code was (re)issued.
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  return now
}

/**
 * Bottom sheet that shows the 6-digit pairing code the user types into the Guardians app.
 * The parent owns the code, its expiry, and the verification result; this component only renders
 * them and counts down to `expiresAt`.
 */
export function PairingCodeSheet(props: PairingCodeSheetProps) {
  const { open, device, code, expiresAt, error, success, onResend, onCancel } = props
  const { mode = 'enter', onConfirm } = props

  // Radix unmounts the content while closed, so the body (and its timer) only exists when open.
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Escape is treated like Cancel; once connected there is nothing left to cancel.
        if (!next && !success) onCancel()
      }}
    >
      <DialogContent
        position="bottom"
        showCloseButton={false}
        // A stray tap on the overlay must not abort a pairing that is already in progress.
        onInteractOutside={event => event.preventDefault()}
        className="gap-5 px-5 pb-5 pt-6"
      >
        <PairingCodeBody
          device={device}
          code={code}
          expiresAt={expiresAt}
          error={error}
          success={success}
          mode={mode}
          onConfirm={onConfirm}
          onResend={onResend}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  )
}

type PairingCodeBodyProps = Omit<PairingCodeSheetProps, 'open' | 'mode'> & { mode: PairingCodeMode }

// 8 digits read more easily in two groups of four.
function formatCompareCode(code: string | null): string {
  return code ? code.replace(/(\d{4})(?=\d)/, '$1 ') : '—'
}

function PairingCodeBody({
  device,
  code,
  expiresAt,
  error,
  success,
  mode,
  onConfirm,
  onResend,
  onCancel
}: PairingCodeBodyProps) {
  const now = useNow(expiresAt !== null && !success)
  const expired = error === 'expired' || (expiresAt !== null && expiresAt - now <= 0)
  // A wrong entry or an expired code can only be recovered by issuing a new one.
  const canResend = expired || error !== null
  const digits = Array.from({ length: CODE_LENGTH }, (_, index) => code?.[index] ?? '—')

  return (
    <>
      <DialogTitle className="flex items-center justify-center gap-2 text-sm font-normal leading-normal">
        <span className="min-w-0 truncate">
          {device ? `#${device.slot} Device · ${device.model}` : 'Device'}
        </span>
        <Pill tone="warning">Guardians</Pill>
      </DialogTitle>

      {success ? (
        <div role="status" className="flex flex-col items-center gap-3 py-6">
          <Icon
            icon="lucide:check"
            width={48}
            height={48}
            className="text-primary"
            aria-hidden="true"
          />
          <DialogDescription className="text-base font-medium text-foreground">
            Device connected
          </DialogDescription>
        </div>
      ) : mode === 'compare' || mode === 'waiting' ? (
        <>
          <DialogDescription className="text-center text-sm text-muted">
            {mode === 'compare'
              ? 'Check that the Guardians app shows the same code as this screen.'
              : 'Waiting for the phone to join…'}
          </DialogDescription>

          <div
            aria-label="Pairing code"
            className="flex justify-center py-2 font-mono text-3xl font-medium tabular-nums tracking-wider"
          >
            {formatCompareCode(code)}
          </div>

          <div className="flex flex-col items-center gap-1">
            {mode === 'compare' && (
              <Button className="w-full" onClick={onConfirm}>
                Codes match
              </Button>
            )}
            <Button variant="ghost" className="w-full" onClick={onCancel}>
              {mode === 'compare' ? "Codes don't match" : 'Cancel'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <DialogDescription className="text-center text-sm text-muted">
            An authorization request has been sent to your phone. Open the Guardians app and enter
            this 6-digit code.
          </DialogDescription>

          <div className="flex justify-center gap-3 py-2 font-mono text-3xl font-medium">
            {digits.map((digit, index) => (
              <span key={index} className="w-7 text-center">
                {digit}
              </span>
            ))}
          </div>

          <div className="space-y-1 text-center text-xs">
            {expired ? (
              <div className="text-danger">Code expired</div>
            ) : (
              expiresAt !== null && (
                <div className="tabular-nums text-muted">
                  Expires in {formatCountdown(expiresAt - now)}
                </div>
              )
            )}
            {error === 'wrong' && (
              <div role="alert" className="text-danger">
                The code entered on the phone was incorrect. Try again.
              </div>
            )}
          </div>

          <div className="flex flex-col items-center gap-1">
            <Button variant="link" disabled={!canResend} onClick={onResend}>
              Resend code
            </Button>
            <Button variant="ghost" className="w-full" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </>
  )
}
