import { Icon } from '@iconify/react'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { ShieldProviderSupport, ShieldProviderLogo, SHIELD_PROVIDERS } from './shield-providers'

const providers = ['near-confidential', 'zcash-shield'] as const

export function ShieldProviderDialog({
  open,
  onClose,
  selected,
  available,
  onSelect,
  networks,
  tokens
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly selected: ShieldProvider | null
  readonly available: Readonly<Record<ShieldProvider, boolean>>
  readonly onSelect: (provider: ShieldProvider) => void
  readonly networks: readonly ChainDefinition[]
  readonly tokens: readonly SwapToken[] | null
}) {
  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent
        position="bottom"
        showCloseButton={false}
        className="flex h-[min(575px,calc(100dvh-2rem))] flex-col gap-0 bg-wallet-surface p-0"
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-4">
          <DialogTitle className="text-base font-medium">Shield Provider</DialogTitle>
          <button
            type="button"
            aria-label="Close Shield Provider"
            onClick={onClose}
            className="wallet-interactive flex size-8 items-center justify-center rounded-md hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Icon icon="lucide:x" width={18} height={18} />
          </button>
        </div>
        <DialogDescription className="sr-only">Choose a receiving provider</DialogDescription>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pt-4 pb-6">
          {providers.map(provider => {
            const { detailName, description } = SHIELD_PROVIDERS[provider]
            return (
              <button
                key={provider}
                type="button"
                disabled={!available[provider]}
                aria-label={detailName}
                aria-pressed={selected === provider}
                onClick={() => onSelect(provider)}
                className={cn(
                  'wallet-interactive flex min-h-[205px] w-full flex-col gap-2 rounded-xl border bg-white/5 px-3.5 pt-[18px] pb-4 text-left enabled:hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-45',
                  selected === provider ? 'border-primary ring-2 ring-primary/30' : 'border-border'
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5 px-1">
                  <ShieldProviderLogo provider={provider} size={30} />
                  <span className="min-w-0 text-lg font-semibold leading-6">{detailName}</span>
                </span>
                <span className="text-xs leading-4 text-wallet-secondary">{description}</span>
                <span className="mt-auto block w-full pt-5">
                  <ShieldProviderSupport provider={provider} networks={networks} tokens={tokens} />
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ShieldSendProviderTabs({
  value,
  onChange,
  availableProviders
}: {
  readonly value: ShieldProvider
  readonly onChange: (provider: ShieldProvider) => void
  readonly availableProviders: readonly ShieldProvider[]
}) {
  return (
    <div className="grid grid-cols-2 border-b border-white/10" aria-label="Shield provider">
      {providers.map(provider => (
        <button
          key={provider}
          type="button"
          aria-pressed={value === provider}
          disabled={!availableProviders.includes(provider)}
          onClick={() => onChange(provider)}
          className={`wallet-interactive relative flex h-12 min-w-0 items-center justify-center gap-2 px-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45 ${value === provider ? 'text-foreground after:absolute after:inset-x-1/4 after:bottom-0 after:h-0.5 after:bg-foreground' : 'text-muted hover:text-foreground'}`}
        >
          <ShieldProviderLogo provider={provider} size={20} />
          {provider === 'near-confidential' ? 'Confidential' : 'Zcash'}
        </button>
      ))}
    </div>
  )
}
