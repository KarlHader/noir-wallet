import { formatConfiguredChainIconUrl, resolveEvmChainIconAlias } from '@/config/icons'

export function formatChainIconUrl(chain: string): string | undefined {
  return formatConfiguredChainIconUrl(chain)
}

export function resolveChainIconAlias(
  family: string,
  displayName: string,
  chainId?: string
): string {
  if (family === 'zcash') return 'zec'
  if (family === 'bitcoin') return 'btc'
  if (family !== 'evm') return family
  if (chainId) return resolveEvmChainIconAlias(chainId)

  const normalized = displayName.toLowerCase()
  if (normalized.includes('arbitrum')) return 'arbitrum'
  if (normalized.includes('base')) return 'base'
  if (normalized.includes('bnb') || normalized.includes('bsc')) return 'bsc'
  if (normalized.includes('optimism') || normalized.startsWith('op ')) return 'optimism'
  if (normalized.includes('polygon')) return 'polygon'
  if (normalized.includes('avalanche')) return 'avax'
  if (normalized.includes('monad')) return 'monad'
  if (normalized.includes('gnosis')) return 'gnosis'
  if (normalized.includes('plasma')) return 'plasma'
  if (normalized.includes('x layer') || normalized.includes('xlayer')) return 'xlayer'
  if (normalized.includes('berachain') || normalized.includes('bera')) return 'bera'
  return 'eth'
}
