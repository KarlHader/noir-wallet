import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

export const PRIVATE_ADDRESS_WARNING =
  'Do not send funds directly to this Private address. Direct transfers can expose the link to the sender. Use Move instead.'

export function PrivateAddressWarningDialog({
  address,
  showQr = false,
  onClose,
  onConfirm
}: {
  readonly address: string | null
  readonly showQr?: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}) {
  return (
    <Dialog open={address !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent position="center" className="max-w-[343px] rounded-2xl p-5">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-warning-surface text-warning">
            <Icon icon="lucide:shield-alert" width={21} height={21} />
          </div>
          <DialogTitle>{showQr ? 'Show' : 'Copy'} Private address?</DialogTitle>
          <DialogDescription className="leading-relaxed text-warning">
            {PRIVATE_ADDRESS_WARNING}
          </DialogDescription>
        </DialogHeader>
        {address && (
          <p className="break-all rounded-lg bg-card p-2.5 font-mono text-[11px] leading-relaxed text-muted">
            {address}
          </p>
        )}
        <DialogFooter className="grid grid-cols-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            {showQr ? 'Show QR code' : 'Copy anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
