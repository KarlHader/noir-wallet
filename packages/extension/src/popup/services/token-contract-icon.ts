import type { SwapToken } from '@/core/services/intents-api'
import { getEvmNetworkConfigs } from '@/config/networks'

export function resolveAssetIdContractIconIdentity(assetId: string | undefined): string | null {
  if (!assetId) return null
  const match = /^(eip155:[1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(assetId)
  return match ? `${match[1]}/erc20:${match[2].toLowerCase()}` : null
}

export function resolveTokenContractIconIdentity(token: SwapToken): string | null {
  const rheaChainId = 'rheaChainId' in token ? token.rheaChainId : null
  if (
    typeof rheaChainId !== 'string' ||
    !/^[1-9][0-9]*$/.test(rheaChainId) ||
    !token.contractAddress ||
    !/^0x[0-9a-fA-F]{40}$/.test(token.contractAddress)
  ) {
    return null
  }
  const network = getEvmNetworkConfigs('mainnet').find(
    candidate => candidate.numericChainId === Number(rheaChainId)
  )
  return network ? `${network.chainId}/erc20:${token.contractAddress.toLowerCase()}` : null
}

export async function lookupTokenContractIcon(
  identity: string,
  isActive: () => boolean
): Promise<string | null> {
  if (!isActive()) return null
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TOKEN_CONTRACT_ICON', identity })
    return isActive() && typeof response?.result === 'string' ? response.result : null
  } catch {
    return null
  }
}
