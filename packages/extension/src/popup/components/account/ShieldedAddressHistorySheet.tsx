import { Icon } from '@iconify/react'
import { CopyFeedbackIcon } from '../common/CopyToast'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { orderShieldedReceiveAddresses } from '@/core/wallet/shielded-address-history'
import { formatSortAddress } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { AccountAddresses, ShieldedReceiveAddress } from '@/types/wallet'

interface ShieldedAddressHistorySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  addresses: readonly ShieldedReceiveAddress[]
  current: AccountAddresses
  disabled: boolean
  selectingAddress: string | null
  error: string | null
  onSelect: (address: string) => void
  onCopy: (address: string, index: number) => void
  isCopied: (index: number) => boolean
}

export function ShieldedAddressHistorySheet({
  open,
  onOpenChange,
  addresses,
  current,
  disabled,
  selectingAddress,
  error,
  onSelect,
  onCopy,
  isCopied
}: ShieldedAddressHistorySheetProps) {
  const ordered = orderShieldedReceiveAddresses(addresses, current)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        position="bottom"
        className="max-h-[78vh] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0"
      >
        <DialogHeader className="border-b border-border px-5 pb-4 pt-5">
          <DialogTitle className="text-center">Shielded addresses</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the default shielded receiving address
          </DialogDescription>
        </DialogHeader>
        <div
          role="region"
          aria-label="Shielded address history"
          className="min-h-0 space-y-2 overflow-y-auto px-4 py-4"
        >
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {ordered.map((address, index) => {
            const isCurrent = address.shielded === current.shielded
            const isSelecting = selectingAddress === address.shielded
            return (
              <div
                key={address.shielded}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-lg border p-2',
                  isCurrent ? 'border-primary/40 bg-primary/10' : 'border-border bg-card'
                )}
              >
                <button
                  type="button"
                  aria-label="Use this shielded address"
                  aria-pressed={isCurrent}
                  disabled={disabled || isCurrent || selectingAddress !== null}
                  onClick={() => onSelect(address.shielded)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left disabled:cursor-default"
                >
                  <Icon
                    icon={isCurrent ? 'lucide:circle-check' : 'lucide:circle'}
                    width={16}
                    height={16}
                    className={cn('shrink-0', isCurrent ? 'text-primary' : 'text-muted')}
                  />
                  <span className="min-w-0 truncate font-mono text-xs" title={address.shielded}>
                    {formatSortAddress(address.shielded)}
                  </span>
                  {isCurrent && <span className="text-xs text-primary">Current</span>}
                  {isSelecting && (
                    <Icon
                      icon="lucide:loader-circle"
                      width={15}
                      height={15}
                      className="ml-auto shrink-0 animate-spin text-primary"
                    />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Copy shielded address"
                  disabled={selectingAddress !== null}
                  onClick={() => onCopy(address.shielded, index)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                >
                  <CopyFeedbackIcon copied={isCopied(index)} width={17} height={17} />
                </button>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
