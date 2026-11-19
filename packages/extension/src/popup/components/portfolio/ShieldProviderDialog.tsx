import { Icon } from '@iconify/react'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { cn } from '@/lib/utils'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { NearShieldSupport, ShieldProviderLogo, SHIELD_PROVIDERS } from './shield-providers'

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
  readonly selected: ShieldProvider
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
            const near = provider === 'near-confidential'
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
                  {near ? (
                    <NearShieldSupport networks={networks} tokens={tokens} />
                  ) : (
                    <span className="grid grid-cols-2 gap-2 text-center text-sm text-wallet-secondary">
                      <span className="flex min-w-0 flex-col items-center gap-1.5">
                        <span aria-hidden="true">
                          <ChainIcon chain="zcash" width={17} height={17} showTooltip={false} />
                        </span>
                        <span>Zcash Supported</span>
                      </span>
                      <span className="flex min-w-0 flex-col items-center gap-1.5">
                        <span aria-hidden="true">
                          <TokenIcon
                            symbol="ZEC"
                            nativeChain="zcash"
                            size={17}
                            showChainBadge={false}
                          />
                        </span>
                        <span>ZEC Supported</span>
                      </span>
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
