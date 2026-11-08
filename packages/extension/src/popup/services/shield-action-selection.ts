import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { getZcashChainId } from '@/core/chains/registry'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { safeBig } from '@/lib/big'
import type { AccountAddresses, KeySource, Network, ZcashBalance } from '@/types/wallet'
import type { AccountNetworksView } from './account-networks-client'
import { summarizeNearConfidentialHoldings } from './near-confidential-holdings'
import { getPrivateTransferChainIds } from './private-balance-transfer'
import { getAvailableZcashSelfMoveSources } from './zcash-self-move'
import type { ShieldProvider } from './asset-domains'

export type ShieldAction = 'send' | 'receive' | 'move' | 'swap'

export function selectShieldActions(input: {
  readonly model: PortfolioReadModel | null
  readonly prices: AssetPriceReadModel | null
  readonly account: AccountNetworksView | null
  readonly network: Network
  readonly zcashAddresses: AccountAddresses | null | undefined
  readonly zcashBalance: ZcashBalance | null | undefined
  readonly zcashKeySource: KeySource | undefined
}) {
  const { model, prices, account, network, zcashAddresses, zcashBalance, zcashKeySource } = input
  const near = summarizeNearConfidentialHoldings(model, prices)
  const nearChainIds = getPrivateTransferChainIds(account, network === 'mainnet')
  const canManageNear = nearChainIds.length > 0
  const hasMovableNear = near.entries.some(
    entry =>
      entry.asset.assetId &&
      nearChainIds.some(chainId => entry.asset.assetId?.startsWith(`${chainId}/`)) &&
      safeBig(entry.asset.availableRaw).gt(0)
  )
  const zcashAssetId = `${getZcashChainId(network)}/slip44:133`
  const hasSpendableNear =
    hasMovableNear ||
    near.entries.some(
      entry => entry.asset.assetId === zcashAssetId && safeBig(entry.asset.availableRaw).gt(0)
    )
  const hasZcash =
    account?.networks.some(item => item.chain.family === 'zcash') ??
    model?.chains.some(chain => chain.chain.family === 'zcash') ??
    false
  const zcashMoveSources = hasZcash
    ? getAvailableZcashSelfMoveSources({
        addresses: zcashAddresses,
        balance: zcashBalance,
        keySource: zcashKeySource,
        network
      })
    : []
  const canSendZcash =
    hasZcash && safeBig(getFundingBalance(zcashBalance, 'shielded').available).gt(0)
  const providersFor = (action: ShieldAction): readonly ShieldProvider[] => {
    const nearAvailable =
      canManageNear &&
      (action === 'receive' ||
        action === 'move' ||
        (action === 'send' && near.status !== 'ready') ||
        hasSpendableNear)
    const zcashAvailable =
      action === 'swap'
        ? false
        : action === 'send'
          ? canSendZcash
          : action === 'receive'
            ? hasZcash
            : zcashMoveSources.length > 0
    return [
      ...(nearAvailable ? (['near-confidential'] as const) : []),
      ...(zcashAvailable ? (['zcash-shield'] as const) : [])
    ]
  }
  return {
    near,
    canManageNear,
    hasMovableNear,
    hasSpendableNear,
    hasZcash,
    zcashMoveSources,
    providersFor
  }
}
