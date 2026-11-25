import type { ChainDefinition } from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatFiatAmount } from '@/lib/number-format'
import type { ShieldProvider } from './asset-domains'

type SupportToken =
  | { readonly token: SwapToken }
  | { readonly symbol: string; readonly nativeChain: string }

interface ShieldSupport {
  readonly networks: readonly string[]
  readonly tokens: readonly SupportToken[]
  readonly networkLabel: string
  readonly tokenLabel: string
}

export const shieldSupportAdapters: Record<
  ShieldProvider,
  (networks: readonly ChainDefinition[], tokens: readonly SwapToken[] | null) => ShieldSupport
> = {
  'near-confidential': (networks, tokens) => ({
    networks: [
      ...(networks.some(network => network.family === 'evm') ? ['evm'] : []),
      ...networks
        .filter(network => network.family !== 'evm')
        .slice(0, 4)
        .map(network => resolveChainIconAlias(network.family, network.displayName))
    ],
    tokens: (tokens ?? []).slice(0, 5).map(token => ({ token })),
    networkLabel: `${networks.length} Supported networks`,
    tokenLabel: `${tokens?.length ?? '—'} Supported tokens`
  }),
  'zcash-shield': () => ({
    networks: ['zcash'],
    tokens: [{ symbol: 'ZEC', nativeChain: 'zcash' }],
    networkLabel: 'Zcash Supported',
    tokenLabel: 'ZEC Supported'
  })
}

export function formatShieldProviderFiat(fiat: string | null | undefined, hidden: boolean): string {
  if (hidden) return '••••'
  if (fiat == null) return '—'
  return formatFiatAmount(fiat, { showSign: true })
}
