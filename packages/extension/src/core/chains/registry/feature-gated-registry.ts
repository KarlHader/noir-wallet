import type { ChainId } from '@/core/chains/domain'
import { parseEnabledChainFeatureFlags } from '@/config/multichain-feature-flags'
import { parseChainId } from './caip2'
import type { ChainDefinition, ChainFeatureFlag, ChainRegistry } from './chain-registry'

const RELEASE_GATED_CHAIN_REGISTRY: unique symbol = Symbol('release-gated-chain-registry')
const ADDRESS_GATED_CHAIN_REGISTRY: unique symbol = Symbol('address-gated-chain-registry')

export interface ReleaseGatedChainRegistry extends ChainRegistry {
  readonly [RELEASE_GATED_CHAIN_REGISTRY]: true
}

export interface AddressGatedChainRegistry extends ChainRegistry {
  readonly [ADDRESS_GATED_CHAIN_REGISTRY]: true
}

export function hasAvailableAddressCapability(chain: ChainDefinition): boolean {
  return chain.capabilities.address.status === 'available'
}

export function hasCompleteChainCapabilities(chain: ChainDefinition): boolean {
  return (
    chain.capabilities.address.status === 'available' &&
    chain.capabilities.signing.status === 'available' &&
    chain.capabilities.transaction.status === 'available'
  )
}

export function createFeatureGatedChainRegistry(
  registry: ChainRegistry,
  enabledFlags: readonly ChainFeatureFlag[]
): ReleaseGatedChainRegistry {
  const enabled = new Set<ChainFeatureFlag>(enabledFlags)
  const visible = Object.freeze(
    registry
      .list()
      .filter(chain => enabled.has(chain.featureFlag) && hasCompleteChainCapabilities(chain))
  )
  const visibleById = new Map<ChainId, ChainDefinition>(visible.map(chain => [chain.id, chain]))

  return Object.freeze({
    [RELEASE_GATED_CHAIN_REGISTRY]: true as const,
    list: () => visible,
    get: (chainId: ChainId) => visibleById.get(chainId),
    resolve: (chainId: string) => {
      const parsed = parseChainId(chainId)
      const configured = registry.get(parsed.id)
      if (!configured) {
        throw new Error(`Unsupported chain: ${chainId}`)
      }
      if (!enabled.has(configured.featureFlag)) {
        throw new Error(`Chain is disabled: ${chainId}`)
      }
      if (!hasCompleteChainCapabilities(configured)) {
        throw new Error(`Chain capability is unavailable: ${chainId}`)
      }
      return configured
    }
  })
}

export function createAddressGatedChainRegistry(
  registry: ChainRegistry,
  enabledFlags: readonly ChainFeatureFlag[]
): AddressGatedChainRegistry {
  const enabled = new Set<ChainFeatureFlag>(enabledFlags)
  const visible = Object.freeze(
    registry
      .list()
      .filter(chain => enabled.has(chain.featureFlag) && hasAvailableAddressCapability(chain))
  )
  const visibleById = new Map<ChainId, ChainDefinition>(visible.map(chain => [chain.id, chain]))

  return Object.freeze({
    [ADDRESS_GATED_CHAIN_REGISTRY]: true as const,
    list: () => visible,
    get: (chainId: ChainId) => visibleById.get(chainId),
    resolve: (chainId: string) => {
      const parsed = parseChainId(chainId)
      const configured = registry.get(parsed.id)
      if (!configured) {
        throw new Error(`Unsupported chain: ${chainId}`)
      }
      if (!enabled.has(configured.featureFlag)) {
        throw new Error(`Chain is disabled: ${chainId}`)
      }
      if (!hasAvailableAddressCapability(configured)) {
        throw new Error(`Chain address capability is unavailable: ${chainId}`)
      }
      return configured
    }
  })
}

export function createBuildFeatureGatedChainRegistry(
  registry: ChainRegistry
): ReleaseGatedChainRegistry {
  const allowedFlags = [...new Set(registry.list().map(chain => chain.featureFlag))]
  const enabledFlags = parseEnabledChainFeatureFlags(
    __ENABLED_CHAIN_FEATURE_FLAGS__.join(','),
    allowedFlags
  )
  return createFeatureGatedChainRegistry(registry, enabledFlags)
}

export function createBuildAddressGatedChainRegistry(
  registry: ChainRegistry
): AddressGatedChainRegistry {
  const allowedFlags = [...new Set(registry.list().map(chain => chain.featureFlag))]
  const enabledFlags = parseEnabledChainFeatureFlags(
    __ENABLED_CHAIN_FEATURE_FLAGS__.join(','),
    allowedFlags
  )
  return createAddressGatedChainRegistry(registry, enabledFlags)
}
