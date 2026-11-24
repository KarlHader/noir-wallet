import type { PortfolioAssetView } from '@/core/portfolio'
import {
  supportsNearPrivateExecution,
  type NearPrivateExecutionWalletSource
} from '@/core/chains/near'

const NEAR_IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/
const RAW_AMOUNT = /^(?:0|[1-9][0-9]*)$/

export type NearSwapBalanceMode = 'main' | 'incognito' | 'shield'

export interface NearSwapBalanceRaw {
  readonly availableRaw?: string
  readonly mainRaw?: string
  readonly privateRaw?: string
  readonly privateOnchainRaw?: string
  readonly confidentialRaw?: string
}

/**
 * Public uses the Main account. Incognito uses the PEA on-chain balance and
 * does not fall back to privateRaw, which also contains confidential holdings.
 * An unsplit snapshot has only availableRaw and stays readable.
 */
export function readNearSwapBalanceRaw(
  balance: NearSwapBalanceRaw,
  mode: NearSwapBalanceMode
): string | undefined {
  if (mode === 'shield') return balance.confidentialRaw
  if (mode === 'incognito') {
    if (balance.privateOnchainRaw !== undefined) return balance.privateOnchainRaw
    if (
      balance.mainRaw !== undefined ||
      balance.privateRaw !== undefined ||
      balance.confidentialRaw !== undefined
    ) {
      return undefined
    }
    return balance.availableRaw
  }
  return balance.mainRaw ?? balance.availableRaw
}

/**
 * Public Send spends the Main account. Incognito spends the PEA on-chain
 * balance and does not fall back to privateRaw, which also contains Shield.
 */
export function readNearSendSpendableRaw(
  balance: NearSwapBalanceRaw & { readonly availableRaw?: string },
  source: 'main' | 'incognito'
): string {
  const value = readNearSwapBalanceRaw(balance, source)
  if (value !== undefined && RAW_AMOUNT.test(value)) return value
  return source === 'incognito' ? '0' : (balance.availableRaw ?? '0')
}

/** Limits a Public Send asset to the Main-account balance before transfer checks. */
export function projectNearPublicSendAsset<
  T extends {
    readonly balance: NearSwapBalanceRaw & {
      readonly availableRaw: string
      readonly spendableRaw: string
    }
  }
>(asset: T): T {
  const raw = readNearSendSpendableRaw(asset.balance, 'main')
  if (raw === asset.balance.availableRaw && raw === asset.balance.spendableRaw) return asset
  return Object.freeze({
    ...asset,
    balance: Object.freeze({
      ...asset.balance,
      availableRaw: raw,
      spendableRaw: raw
    })
  })
}

function selectNearBalance(
  asset: PortfolioAssetView,
  mode: 'main' | 'private'
): PortfolioAssetView | null {
  // Incognito execution needs the PEA bucket. availableRaw can include the Main account.
  if (mode === 'private' && asset.balance.privateOnchainRaw === undefined) return null
  const selectedRaw = readNearSwapBalanceRaw(
    asset.balance,
    mode === 'private' ? 'incognito' : 'main'
  )
  if (selectedRaw === undefined) return null
  return Object.freeze({
    ...asset,
    balance: Object.freeze({
      ...asset.balance,
      totalRaw: selectedRaw,
      spendableRaw: selectedRaw,
      availableRaw: selectedRaw
    })
  })
}

export interface NearQuoteAssetExecutionSource {
  readonly asset: PortfolioAssetView
  readonly networkFeeAsset: PortfolioAssetView
  readonly refundAddress: string
}

export function selectNearQuoteAssetExecution<T extends NearQuoteAssetExecutionSource>(
  source: T,
  mode: 'main' | 'private',
  privateExecutionAddress?: string
): T | null {
  const asset = selectNearBalance(source.asset, mode)
  const networkFeeAsset = selectNearBalance(source.networkFeeAsset, mode)
  if (!asset || !networkFeeAsset) return null
  if (mode === 'main') {
    return Object.freeze({ ...source, asset, networkFeeAsset })
  }
  if (
    !privateExecutionAddress ||
    !NEAR_IMPLICIT_ACCOUNT.test(privateExecutionAddress) ||
    privateExecutionAddress === source.refundAddress
  ) {
    return null
  }
  return Object.freeze({
    ...source,
    asset,
    networkFeeAsset,
    refundAddress: privateExecutionAddress
  })
}

export function nearPrivateSwapExecutionAvailable(input: {
  readonly enabledFlags: readonly string[]
  readonly walletSource?: NearPrivateExecutionWalletSource | null
  readonly privateExecutionAddress?: string | null
  readonly mainAddresses?: readonly string[]
}): boolean {
  if (!input.enabledFlags.includes('chain.near')) return false
  if (!supportsNearPrivateExecution(input.walletSource)) return false
  const pea = input.privateExecutionAddress
  if (!pea || !NEAR_IMPLICIT_ACCOUNT.test(pea)) return false
  return !(input.mainAddresses ?? []).includes(pea)
}
