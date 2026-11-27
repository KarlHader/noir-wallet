import Big from 'big.js'
import type { PortfolioAssetView, PortfolioReadModel } from '@/core/portfolio'
import { getZcashChainId, type ChainDefinition } from '@/core/chains/registry'
import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { isNewWalletFamilyEnabled } from '@/core/chains/feature-runtime-policy'
import type { AssetPriceReadModel } from '@/core/prices'
import type { SwapToken } from '@/core/services/intents-api'
import type { Network } from '@/types'
import { getAssetDomainRaw, type ShieldProvider } from './asset-domains'
import { resolveManagedIntentsCatalog } from './intents-asset-manager-client'
import { getPortfolioAssetUsdValue } from './portfolio-prices'
import { getShieldTransferChainIds, listShieldFundingAssets } from './shield-transfer'
import { getConfidentialZcashTransferRecipients } from './zcash-self-transfer'
import { hasNativeZecConfidentialSwapRoute } from './shield-swap-zec-sources'
import type { AccountNetworksView } from './account-networks-client'

export interface QuickShieldAsset {
  readonly asset: PortfolioAssetView
  readonly chain: ChainDefinition
  readonly availableRaw: string
  readonly providers: readonly [ShieldProvider, ...ShieldProvider[]]
  readonly valueUsd: string | null
}
export function quickShieldSpendableRaw(
  asset: PortfolioAssetView,
  nativeZec = false
): string | null {
  const publicRaw = getAssetDomainRaw(asset, 'public')
  const spendable = nativeZec ? asset.balance.shieldableRaw : asset.balance.availableRaw
  if (publicRaw == null || spendable == null) return null
  return BigInt(spendable) < BigInt(publicRaw) ? spendable : publicRaw
}

export function getQuickShieldAssets({
  model,
  account,
  network,
  catalog,
  prices,
  enabledFlags
}: {
  readonly model: PortfolioReadModel
  readonly account: AccountNetworksView
  readonly network: Network
  readonly catalog: readonly SwapToken[]
  readonly prices: AssetPriceReadModel | null
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
}): QuickShieldAsset[] {
  const nearChains = new Set(
    getShieldTransferChainIds(
      account,
      network === 'mainnet' && isNewWalletFamilyEnabled('evm', enabledFlags)
    )
  )
  const nativeZcashChain = getZcashChainId(network)
  const { walletSource } = account
  const nativeZcashEnabled =
    isNewWalletFamilyEnabled('zcash', enabledFlags) &&
    (walletSource.kind === 'software' ||
      (walletSource.kind === 'hardware' &&
        walletSource.hardware.vendor === 'ledger' &&
        walletSource.hardware.capabilities.includes('zcash')))
  const nearZcashEnabled =
    nativeZcashEnabled &&
    walletSource.kind !== 'hardware' &&
    nearChains.size > 0 &&
    hasNativeZecConfidentialSwapRoute(account, network, enabledFlags)
  const nearAssets = new Set(
    nearChains.size
      ? listShieldFundingAssets(model, resolveManagedIntentsCatalog(catalog), catalog, network).map(
          entry => entry.asset.asset.id
        )
      : []
  )
  const zcashAddresses = getConfidentialZcashTransferRecipients(account, network)
  const hasTransparentAddress = zcashAddresses.some(address => address.privacy === 'transparent')
  const canShieldNativeZcash =
    nativeZcashEnabled &&
    hasTransparentAddress &&
    zcashAddresses.some(address => address.privacy === 'shielded')
  const rows: QuickShieldAsset[] = []

  for (const { chain, assets } of model.chains) {
    if (chain.capabilities.transaction.status !== 'available') continue
    for (const asset of assets) {
      const nativeZec = chain.id === nativeZcashChain && asset.asset.kind === 'native'
      const availableRaw = quickShieldSpendableRaw(asset, nativeZec)
      if (availableRaw === null || BigInt(availableRaw) <= 0n) continue

      const providers: ShieldProvider[] = []
      if (nativeZec && canShieldNativeZcash) providers.push('zcash-shield')
      if (
        nearAssets.has(asset.asset.id) &&
        (nearChains.has(chain.id) || (nativeZec && nearZcashEnabled && hasTransparentAddress))
      ) {
        providers.push('near-confidential')
      }
      const [provider, ...otherProviders] = providers
      if (!provider) continue

      rows.push({
        asset,
        chain,
        availableRaw,
        providers: [provider, ...otherProviders],
        valueUsd: getPortfolioAssetUsdValue(asset, prices, availableRaw)
      })
    }
  }

  return rows.sort((left, right) => new Big(right.valueUsd ?? 0).cmp(left.valueUsd ?? 0))
}

export function getQuickShieldTotalUsd(assets: readonly QuickShieldAsset[]): string | null {
  let total: Big | null = null
  for (const { valueUsd } of assets) {
    if (valueUsd === null) continue
    total = total === null ? new Big(valueUsd) : total.plus(valueUsd)
  }
  return total?.toFixed() ?? null
}
