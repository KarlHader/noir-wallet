import type { PortfolioChainView } from '@/core/portfolio'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount, formatTokenQuantity } from '@/lib/number-format'

/** Portfolio and Activity share the summary quantity profile. */
export function formatDisplayAmount(value: Big): string {
  if (value.lt(0)) throw new Error('Invalid display amount')
  return formatTokenQuantity(value.toFixed())
}

/** Base-unit convenience wrapper around {@link formatDisplayAmount}. */
export function formatDisplayTokenAmount(rawAmount: string, decimals: number): string {
  return formatTokenQuantity(formatBaseUnitDecimalAmount(rawAmount, decimals))
}

/** Activity uses the same quantity profile as holdings. */
export function formatActivityTokenAmount(rawAmount: string, decimals: number): string {
  return formatDisplayTokenAmount(rawAmount, decimals)
}

export function formatNetworkDisplayName(displayName: string, networkName: string): string {
  const normalizedNetwork = networkName.toLowerCase()
  const displayWords = displayName.toLowerCase().split(/[\s_-]+/)
  const networkWords = normalizedNetwork.split(/[\s_-]+/)
  if (networkWords.includes('mainnet')) {
    return displayName.replace(/\s+mainnet$/i, '').trim()
  }
  if (
    networkWords.some(word =>
      ['testnet', 'testnet3', 'devnet', 'sepolia', 'amoy', 'fuji'].includes(word)
    ) &&
    networkWords.some(word => displayWords.includes(word.replace(/\d+$/, '')))
  ) {
    return displayName
  }
  if (displayWords.includes(normalizedNetwork)) return displayName
  return `${displayName} · ${networkName.charAt(0).toUpperCase()}${networkName.slice(1)}`
}

export function formatPortfolioNetworkName(chain: PortfolioChainView): string {
  return formatNetworkDisplayName(chain.chain.displayName, chain.chain.network.name)
}
