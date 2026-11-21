import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { getEvmNetworkConfigs } from '@/config/networks'
import type { PortfolioReadModel } from '@/core/portfolio'
import { getZcashChainId } from '@/core/chains/registry'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import {
  isNewWalletFamilyEnabled,
  resolveEvmFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '@/core/chains/registry'
import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import type { KeySource, Network } from '@/types'
import type { AccountNetworksView } from './account-networks-client'
import { getAssetDomainRaw } from './asset-domains'
import type { ShieldFundingAsset } from './shield-transfer'
import { getZcashTokenPickerChain, shieldFundingAvailableRaw } from './shield-transfer'

export const SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID = 'shield-swap-source:zec:intents' as const
export const SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID = 'shield-swap-source:zec:native-shielded' as const
export const SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID =
  'shield-swap-source:zec:transparent' as const

export type ShieldSwapZecSourceKind = 'intents' | 'native-shielded' | 'native-transparent'

export function parseShieldSwapZecSourceParam(
  value: string | null | undefined
): ShieldSwapZecSourceKind | null {
  if (value === 'intents') return 'intents'
  if (value === 'native' || value === 'native-shielded') return 'native-shielded'
  if (value === 'native-transparent') return 'native-transparent'
  return null
}

export function shieldSwapZecSourceParam(kind: ShieldSwapZecSourceKind): string {
  return kind === 'native-shielded' ? 'native' : kind
}

export function isShieldSwapZecSelectionId(id: string | null | undefined): boolean {
  return (
    id === SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID ||
    id === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID ||
    id === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
  )
}

export interface ShieldSwapZecSourceOption {
  readonly selectionId: string
  readonly kind: ShieldSwapZecSourceKind
  readonly symbol: string
  readonly iconUrl?: string
  readonly badgeBlockchain: string
  readonly chainId: string
  readonly chainName: string
  readonly sourceLabel?: string
  readonly availableRaw: string
  readonly decimals: number
  readonly intentsWalletAssetId?: string
  readonly disabledReason?: string
}

function isZecSymbol(symbol: string): boolean {
  return symbol.trim().toUpperCase() === 'ZEC'
}

function findIntentsZecFundingAsset(
  sources: readonly ShieldFundingAsset[]
): ShieldFundingAsset | null {
  return sources.find(asset => asset.managed.protocolAssetId === ZEC_ZCASH_ASSET) ?? null
}

function zcashShieldNativeAsset(model: PortfolioReadModel | null, network: Network) {
  const zcashChainId = getZcashChainId(network)
  return (
    model?.assets.find(
      asset =>
        asset.asset.chainId === zcashChainId &&
        asset.asset.kind === 'native' &&
        isZecSymbol(asset.metadata.symbol)
    ) ?? null
  )
}

export function resolveShieldNativeZecSwapAvailable(input: {
  readonly network: Network
  readonly portfolio: PortfolioReadModel | null
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
  readonly zcashAccountEnabled: boolean
}): boolean {
  const zcashReleased = isNewWalletFamilyEnabled('zcash', input.enabledFlags)
  const registry = createBuildAddressGatedChainRegistry(
    createInitialProductChainRegistry(input.network)
  )
  const zcashInProduct = registry.list().some(chain => chain.family === 'zcash')
  return zcashReleased && zcashInProduct && input.zcashAccountEnabled
}

export function hasNativeZecConfidentialSwapRoute(
  account: AccountNetworksView | null,
  network: Network,
  enabledFlags: readonly ChainFeatureFlagValue[]
): boolean {
  const settlementChainId = getEvmNetworkConfigs(network)[0]?.chainId
  return Boolean(
    resolveEvmFeatureRuntimePolicy(enabledFlags).newOperationsEnabled &&
    supportsEvmPrivateExecution(account?.walletSource) &&
    account?.networks.some(entry => entry.chain.id === settlementChainId)
  )
}

export function canSwapNativeShieldZec(input: {
  readonly account: AccountNetworksView | null
  readonly network: Network
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
  readonly keySource: KeySource | undefined
}): boolean {
  const { account, network, enabledFlags, keySource } = input
  return (
    network === 'mainnet' &&
    !getFundingSourceUnavailableReason(keySource, 'shielded') &&
    hasNativeZecConfidentialSwapRoute(account, network, enabledFlags) &&
    resolveShieldNativeZecSwapAvailable({
      network,
      portfolio: null,
      enabledFlags,
      zcashAccountEnabled: account?.networks.some(entry => entry.chain.family === 'zcash') ?? false
    })
  )
}

export function buildShieldSwapZecSourceOptions(input: {
  readonly network: Network
  readonly sources: readonly ShieldFundingAsset[]
  readonly balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
  readonly portfolio: PortfolioReadModel | null
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
  readonly zcashAccountEnabled: boolean
  readonly keySource: KeySource | undefined
}): readonly ShieldSwapZecSourceOption[] {
  const intentsAsset = findIntentsZecFundingAsset(input.sources)
  const options: ShieldSwapZecSourceOption[] = []
  const zcashChain = getZcashTokenPickerChain(input.network)

  if (intentsAsset) {
    const availableRaw = shieldFundingAvailableRaw(intentsAsset, input.balances)
    options.push(
      Object.freeze({
        selectionId: SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID,
        kind: 'intents',
        symbol: intentsAsset.asset.metadata.symbol,
        iconUrl: intentsAsset.asset.metadata.iconUrl,
        ...zcashChain,
        sourceLabel: 'NEAR Confidential',
        availableRaw,
        decimals: intentsAsset.asset.metadata.decimals,
        intentsWalletAssetId: intentsAsset.asset.asset.id
      })
    )
  }

  if (
    resolveShieldNativeZecSwapAvailable({
      network: input.network,
      portfolio: input.portfolio,
      enabledFlags: input.enabledFlags,
      zcashAccountEnabled: input.zcashAccountEnabled
    })
  ) {
    const nativeAsset = zcashShieldNativeAsset(input.portfolio, input.network)
    const shieldedRaw = nativeAsset ? getAssetDomainRaw(nativeAsset, 'shield') : null
    try {
      const availableRaw = (
        BigInt(shieldedRaw ?? '0') - BigInt(nativeAsset?.balance.shieldedPendingRaw ?? '0')
      ).toString()
      if (nativeAsset && shieldedRaw !== null && BigInt(availableRaw) >= 0n) {
        options.push(
          Object.freeze({
            selectionId: SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID,
            kind: 'native-shielded',
            symbol: nativeAsset.metadata.symbol,
            iconUrl: nativeAsset.metadata.iconUrl,
            ...zcashChain,
            availableRaw,
            decimals: nativeAsset.metadata.decimals
          })
        )
      }
    } catch {
      // Omit native ZEC when shielded balance is unavailable.
    }
  }

  return Object.freeze(options)
}

export function resolveShieldConfidentialFromAssetId(
  fromId: string | null,
  zecOptions: readonly ShieldSwapZecSourceOption[]
): string | null {
  if (!fromId || isShieldSwapZecSelectionId(fromId)) {
    const intents = zecOptions.find(option => option.kind === 'intents')
    return intents?.intentsWalletAssetId ?? null
  }
  return fromId
}
