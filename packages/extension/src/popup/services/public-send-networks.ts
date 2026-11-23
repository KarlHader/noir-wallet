import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { isSelectableChainFamily } from './chain-selection-availability'
import { sortTokenSelectorNetworks } from './token-selector-chain-order'

export interface PublicSendNetworkChain {
  readonly id: string
  readonly family: string
  readonly displayName: string
  readonly transactionAvailable: boolean
}

export interface PublicSendNetworkOption {
  readonly chainId: string
  readonly name: string
  readonly icon: string
  readonly switchesAsset: boolean
}

export type PublicSendNetworkAction = 'ignore' | 'zcash' | 'native' | 'cross-chain'

const BRIDGED_FAMILIES = new Set(['evm', 'solana'])

function canSwitchTo(
  chain: PublicSendNetworkChain,
  sourceId: string,
  enabledFlags: readonly ChainFeatureFlagValue[]
) {
  return (
    chain.id !== sourceId &&
    chain.transactionAvailable &&
    isSelectableChainFamily(chain.family, enabledFlags)
  )
}

function toOption(chain: PublicSendNetworkChain, switchesAsset: boolean): PublicSendNetworkOption {
  return {
    chainId: chain.id,
    name: chain.displayName,
    icon: resolveChainIconAlias(chain.family, chain.displayName, chain.id),
    switchesAsset
  }
}

/**
 * Public Send network list. EVM and Solana keep same-asset bridge destinations.
 * NEAR and Zcash switch the form to that chain's public transfer instead.
 */
export function buildPublicSendDestinationNetworks(input: {
  readonly source: PublicSendNetworkChain
  readonly accountChains: readonly PublicSendNetworkChain[]
  readonly crossChainChains: readonly PublicSendNetworkChain[]
  readonly zcash: Readonly<{ chainId: string; name: string; icon: string }> | null
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
}): readonly PublicSendNetworkOption[] {
  const sourceFamily = input.source.family
  const sourceOption =
    input.zcash && sourceFamily === 'zcash' && input.zcash.chainId === input.source.id
      ? {
          chainId: input.source.id,
          name: input.zcash.name,
          icon: input.zcash.icon,
          switchesAsset: false
        }
      : toOption(input.source, false)
  const bridged = BRIDGED_FAMILIES.has(sourceFamily)
    ? input.crossChainChains
        .filter(chain => chain.id !== input.source.id && BRIDGED_FAMILIES.has(chain.family))
        .map(chain => toOption(chain, false))
    : []
  const switches: PublicSendNetworkOption[] = []
  if (
    input.zcash &&
    input.zcash.chainId !== input.source.id &&
    (sourceFamily === 'evm' || sourceFamily === 'solana' || sourceFamily === 'near')
  ) {
    switches.push({ ...input.zcash, switchesAsset: true })
  }
  if (sourceFamily === 'evm' || sourceFamily === 'solana' || sourceFamily === 'zcash') {
    switches.push(
      ...input.accountChains
        .filter(
          chain =>
            chain.family === 'near' && canSwitchTo(chain, input.source.id, input.enabledFlags)
        )
        .map(chain => toOption(chain, true))
    )
  }
  if (sourceFamily === 'near' || sourceFamily === 'zcash') {
    switches.push(
      ...input.accountChains
        .filter(
          chain =>
            BRIDGED_FAMILIES.has(chain.family) &&
            canSwitchTo(chain, input.source.id, input.enabledFlags)
        )
        .map(chain => toOption(chain, true))
    )
  }
  const seen = new Set<string>()
  const unique = [sourceOption, ...bridged, ...switches].filter(option => {
    if (seen.has(option.chainId)) return false
    seen.add(option.chainId)
    return true
  })
  return sortTokenSelectorNetworks(unique, option => ({ id: option.chainId, name: option.name }))
}

export function resolvePublicSendNetworkAction(input: {
  readonly destinationChainId: string
  readonly sourceChainId: string
  readonly options: readonly Pick<PublicSendNetworkOption, 'chainId' | 'switchesAsset'>[]
  readonly zcashChainId: string | null
  readonly crossChainChainIds: readonly string[]
}): PublicSendNetworkAction {
  if (input.destinationChainId === input.sourceChainId) return 'ignore'
  const option = input.options.find(item => item.chainId === input.destinationChainId)
  if (option?.switchesAsset) return option.chainId === input.zcashChainId ? 'zcash' : 'native'
  return input.crossChainChainIds.includes(input.destinationChainId) ? 'cross-chain' : 'ignore'
}
