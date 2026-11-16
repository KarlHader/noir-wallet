import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { IntentsManagedAsset } from '@/core/services/intents-managed-assets'
import type { SwapToken } from '@/core/services/intents-api'
import type { Network } from '@/types'
import { getConfidentialAvailableForAsset } from '@/core/services/confidential-funding'
import {
  getTransferDomainBalanceRaw,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'
import { resolveShieldManagedAsset } from '@/popup/services/shield-transfer'

const STORAGE_PREFIX = 'shield_move_preference_v1:'
const ETHEREUM_USDC_ASSET_ID = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

export interface ShieldMovePreference {
  readonly provider: 'near-confidential'
  readonly assetId: string
  readonly destinationAssetId: string | null
  readonly from: TransferDomain
  readonly to: TransferDomain
}

export function shieldMovePreferenceKey(
  network: Network,
  walletId: string,
  accountId: string
): string {
  return `${STORAGE_PREFIX}${JSON.stringify([network, walletId, accountId])}`
}

export function readShieldMovePreference(value: unknown): ShieldMovePreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    item.provider !== 'near-confidential' ||
    typeof item.assetId !== 'string' ||
    !item.assetId ||
    (item.destinationAssetId !== null && typeof item.destinationAssetId !== 'string') ||
    !(
      (item.from === 'public' && item.to === 'shield') ||
      (item.from === 'private' && item.to === 'shield') ||
      (item.from === 'shield' && (item.to === 'public' || item.to === 'private'))
    )
  )
    return null
  return item as unknown as ShieldMovePreference
}

type MoveAsset = Readonly<{ asset: PortfolioAssetView; chain: PortfolioChainView }>

export function selectShieldMoveAssetId(input: {
  readonly assets: readonly MoveAsset[]
  readonly eligibleChainIds: readonly string[]
  readonly managedAssets: readonly IntentsManagedAsset[]
  readonly catalogTokens: readonly SwapToken[]
  readonly network: Network
  readonly from: TransferDomain
  readonly shieldBalances?: readonly Readonly<{ tokenId: string; available: string }>[] | null
  readonly preferredAssetId?: string | null
}): string | null {
  const candidates = input.assets.filter(item => {
    const chain = item.chain.chain
    const managed = resolveShieldManagedAsset(
      item.asset,
      input.managedAssets,
      input.catalogTokens,
      input.network
    )
    const sourceAvailable =
      input.from === 'shield'
        ? managed && input.shieldBalances
          ? BigInt(
              getConfidentialAvailableForAsset(input.shieldBalances, managed.protocolAssetId) ?? '0'
            ) > 0n
          : false
        : getTransferDomainBalanceRaw(item.asset, input.from) !== null
    return (
      chain.family === 'evm' &&
      chain.capabilities.transaction.status === 'available' &&
      input.eligibleChainIds.includes(chain.id) &&
      sourceAvailable &&
      managed !== null
    )
  })
  const funded =
    input.from === 'shield'
      ? candidates
      : candidates.filter(
          item => BigInt(getTransferDomainBalanceRaw(item.asset, input.from) ?? '0') > 0n
        )
  const preferred = (items: typeof candidates) =>
    items.find(item => item.asset.asset.id === input.preferredAssetId) ??
    items.find(item => item.asset.asset.id === ETHEREUM_USDC_ASSET_ID) ??
    items[0]
  return (preferred(funded) ?? preferred(candidates))?.asset.asset.id ?? null
}
