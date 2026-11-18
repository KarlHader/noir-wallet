import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { resolveIntentsWalletAsset } from '@/core/services/intents-wallet-assets'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

function managedAssetId(token: RheaSwapToken): string | null {
  if (token.isNative) return null
  if (/^[1-9]\d*$/.test(token.rheaChainId)) {
    const address = token.rheaAddress.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) return null
    return `eip155:${token.rheaChainId}/erc20:${address}`
  }
  return (
    resolveIntentsWalletAsset({ ...token, contractAddress: token.rheaAddress }, DEFAULT_NETWORK)
      ?.assetId ?? null
  )
}

export function filterManuallyHiddenSwapTokens(
  tokens: readonly RheaSwapToken[],
  hiddenAssetIds: ReadonlySet<string>
): readonly RheaSwapToken[] {
  if (hiddenAssetIds.size === 0) return tokens
  return tokens.filter(token => {
    if (hiddenAssetIds.has(token.assetId)) return false
    const managedId = managedAssetId(token)
    return !managedId || !hiddenAssetIds.has(managedId)
  })
}
