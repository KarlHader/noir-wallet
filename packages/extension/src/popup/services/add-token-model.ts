import {
  getNearNetworkConfig,
  getSolanaNetworkConfig,
  type EvmNetworkConfig
} from '@/config/networks'
import type { UserEvmAssetCandidate } from '@/core/chains/user-assets'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import type { Network } from '@/types'
import {
  DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS,
  type ChainFeatureFlagValue
} from '@/config/multichain-feature-flags'
import { deferredChainChoices, isSelectableChainFamily } from './chain-selection-availability'

export type AddTokenNetwork = Readonly<{
  chainId: string
  displayName: string
  iconChain: string
  family: 'evm' | 'near' | 'solana' | 'bitcoin'
  disabled?: true
}>

export type AddTokenCandidate =
  | Readonly<{ kind: 'evm'; asset: UserEvmAssetCandidate }>
  | Readonly<{ kind: 'protocol'; asset: IntentsManagedAsset }>

export function buildAddTokenNetworks(
  network: Network,
  evmNetworks: readonly EvmNetworkConfig[],
  enabledFlags: readonly ChainFeatureFlagValue[] = DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS
): readonly AddTokenNetwork[] {
  const near = getNearNetworkConfig(network)
  const solana = getSolanaNetworkConfig(network)
  return Object.freeze([
    ...(isSelectableChainFamily('evm', enabledFlags) ? evmNetworks : []).map(evmNetwork => ({
      chainId: evmNetwork.chainId,
      displayName: evmNetwork.displayName,
      iconChain: evmNetwork.iconChain,
      family: 'evm' as const
    })),
    ...(network === 'mainnet' && isSelectableChainFamily('near', enabledFlags)
      ? [
          {
            chainId: near.chainId,
            displayName: near.displayName,
            iconChain: 'near',
            family: 'near' as const
          }
        ]
      : []),
    ...(network === 'mainnet' && isSelectableChainFamily('solana', enabledFlags)
      ? [
          {
            chainId: solana.chainId,
            displayName: solana.displayName,
            iconChain: 'solana',
            family: 'solana' as const
          }
        ]
      : []),
    ...deferredChainChoices(enabledFlags).map(choice => ({
      chainId: `coming-soon:${choice.family}`,
      displayName: choice.label,
      iconChain: choice.iconAlias,
      family: choice.family,
      disabled: true as const
    }))
  ])
}

export function getAddTokenReferencePresentation(network: AddTokenNetwork | undefined): Readonly<{
  label: string
  placeholder: string
}> {
  if (!network) {
    return Object.freeze({ label: 'Token address', placeholder: 'Select network' })
  }
  if (network?.family === 'evm') {
    return Object.freeze({ label: 'EVM contract address', placeholder: '0x…' })
  }
  if (network?.family === 'solana') {
    return Object.freeze({ label: 'SPL Token mint address', placeholder: 'Token mint address' })
  }
  return Object.freeze({ label: 'NEP-141 contract account', placeholder: 'token.near' })
}

export function isAddTokenReferenceSearch(
  query: string,
  network: AddTokenNetwork | undefined
): boolean {
  if (!network || network.disabled) return false
  const reference = query.trim()
  if (network.family === 'evm') {
    return /^0x[0-9a-fA-F]{40}$/.test(reference) && !/^0x0{40}$/i.test(reference)
  }
  try {
    if (network.family === 'solana') return parseSolanaPublicKey(reference) === reference
    if (network.family === 'near' && reference.includes('.')) {
      return parseNearAccountId(reference) === reference
    }
  } catch {
    return false
  }
  return false
}

export function getVerifiedTokenPresentation(candidate: AddTokenCandidate | null): Readonly<{
  assetId: string
  name: string
  symbol: string
  decimals: number
  iconUrl?: string
  blockchain?: string
  reference: string
}> | null {
  if (!candidate) return null
  if (candidate.kind === 'evm') {
    return Object.freeze({
      assetId: candidate.asset.assetId,
      name: candidate.asset.metadata.name,
      symbol: candidate.asset.metadata.symbol,
      decimals: candidate.asset.metadata.decimals,
      ...(candidate.asset.metadata.iconUrl ? { iconUrl: candidate.asset.metadata.iconUrl } : {}),
      reference: candidate.asset.contractAddress
    })
  }
  return Object.freeze({
    assetId: candidate.asset.assetId,
    name: candidate.asset.symbol,
    symbol: candidate.asset.symbol,
    decimals: candidate.asset.decimals,
    ...(candidate.asset.iconUrl ? { iconUrl: candidate.asset.iconUrl } : {}),
    blockchain: candidate.asset.blockchain,
    reference: candidate.asset.reference.replace(/%5F/gi, '_')
  })
}
