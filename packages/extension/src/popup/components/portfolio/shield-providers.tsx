import nearLogo from '@/images/figma-near-confidential.svg'
import zcashLogo from '@/images/figma-zcash-shield.svg'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { cn } from '@/lib/utils'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { shieldSupportAdapters } from '@/popup/services/shield-provider-presentation'

export const SHIELD_PROVIDERS: Readonly<
  Record<
    ShieldProvider,
    { name: string; detailName: string; description: string; logo: string; tint: string }
  >
> = {
  'near-confidential': {
    name: 'NEAR Confidential',
    detailName: 'NEAR Confidential Intents',
    description:
      'Confidential Intents extend the NEAR Intents protocol with privacy-preserving swaps. Market makers can provide liquidity on a private chain where balances and swap details are shielded from public view.',
    logo: nearLogo,
    tint: '#0c6e57'
  },
  'zcash-shield': {
    name: 'Zcash shield',
    detailName: 'Zcash Shield',
    description: 'Receive ZEC directly to your shielded address on Zcash.',
    logo: zcashLogo,
    tint: '#424252'
  }
}

export function ShieldProviderSupport({
  provider,
  networks,
  tokens
}: {
  readonly provider: ShieldProvider
  readonly networks: readonly ChainDefinition[]
  readonly tokens: readonly SwapToken[] | null
}) {
  const support = shieldSupportAdapters[provider](networks, tokens)
  return (
    <span className="grid grid-cols-2 gap-2 text-center text-sm text-wallet-secondary">
      <span className="min-w-0">
        <span
          aria-hidden="true"
          className="flex min-h-5 flex-wrap items-center justify-center gap-1"
        >
          {support.networks.map((chain, index) => (
            <ChainIcon
              key={`${chain}:${index}`}
              chain={chain}
              width={17}
              height={17}
              showTooltip={false}
              className={cn(
                chain !== 'evm' &&
                  provider === 'near-confidential' &&
                  'shrink-0 rounded-full border border-background'
              )}
            />
          ))}
        </span>
        <span className="mt-1 block">{support.networkLabel}</span>
      </span>
      <span className="min-w-0">
        <span aria-hidden="true" className="flex min-h-5 items-center justify-center -space-x-1">
          {support.tokens.map(entry => (
            <TokenIcon
              key={'token' in entry ? entry.token.assetId : entry.symbol}
              {...entry}
              showChainBadge={false}
              size={17}
              className={
                'token' in entry ? 'shrink-0 rounded-full border border-background' : undefined
              }
            />
          ))}
        </span>
        <span className="mt-1 block">{support.tokenLabel}</span>
      </span>
    </span>
  )
}

export function ShieldProviderLogo({
  provider,
  size = 36
}: {
  readonly provider: ShieldProvider
  readonly size?: number
}) {
  return (
    <img
      src={SHIELD_PROVIDERS[provider].logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0 rounded-[5px] object-contain"
    />
  )
}
