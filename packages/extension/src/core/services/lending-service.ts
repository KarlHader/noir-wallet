import {
  getMcaByWallet,
  batchViewsData,
  getUnclaimedRewards,
  getFarmDetailsOfAsset,
  setCustomNodeUrl,
  type IAssetsView,
  type Portfolio,
  type IConfig,
  type IBatchViewsWithTransformsResult
} from '@rhea-finance/cross-chain-sdk'
import { clearLendingMcaCache, getMcaCacheKey, runMcaCheckDeduped } from './lending-mca-cache'
import { safeBig } from '@/lib/big'
import { ZEC_NEAR_TOKEN_ID } from '@/config/intents'
import { formatAmount } from '@/lib/number-format'
import { parseEvmAddress } from '@/core/dapp/eip1193'

export const REWARD_TOKEN_ID = 'lst.rhealab.near'
export const REWARD_TOKEN_ID_DECIMALS = 24

export type LendingSigningMode = 'derived' | 'legacy' | 'legacy_index0'
export type ResolveZcashLendingPublicKey = (mode: LendingSigningMode) => Promise<string>

export interface LendingMcaStatus {
  mcaId: string | null
  publicKey: string | null
  signingMode: LendingSigningMode
}

export interface LendingData {
  assetsView: IAssetsView
  portfolioView: Portfolio | undefined
  config: IConfig
}

/**
 * Auto-detect MCA account with priority:
 * 1. legacy BIP-44 index 0 pubkey -> if bound MCA exists, use it
 * 2. derived pubkey -> if bound MCA exists, use it
 * 3. no MCA found -> default to derived mode for new users
 */
export async function checkLendingMcaAccount(
  walletId?: string,
  accountId?: string,
  resolveZcashPublicKey?: ResolveZcashLendingPublicKey
): Promise<LendingMcaStatus> {
  if (!walletId || !accountId || !resolveZcashPublicKey) {
    throw new Error('Wallet, account ID and identity resolver required for MCA check')
  }

  const cacheKey = getMcaCacheKey(walletId, accountId)

  return runMcaCheckDeduped(cacheKey, async () => {
    const legacyPublicKey = await resolveZcashPublicKey('legacy')
    if (legacyPublicKey) {
      const mcaId = await getMcaByWallet({
        chain: 'zcash',
        identityKey: legacyPublicKey
      })
      if (mcaId) {
        console.log(`[Lending] MCA detected: mode=legacy_index0, mcaId=${mcaId}`)
        return { mcaId, publicKey: legacyPublicKey, signingMode: 'legacy_index0' }
      }
    }

    const derivedPublicKey = await resolveZcashPublicKey('derived')
    if (derivedPublicKey) {
      const mcaId = await getMcaByWallet({
        chain: 'zcash',
        identityKey: derivedPublicKey
      })
      if (mcaId) {
        console.log(`[Lending] MCA detected: mode=derived, mcaId=${mcaId}`)
        return { mcaId, publicKey: derivedPublicKey, signingMode: 'derived' }
      }
    }

    console.log('[Lending] No MCA found, defaulting to derived mode')
    return {
      mcaId: null,
      publicKey: derivedPublicKey || null,
      signingMode: 'derived'
    }
  })
}

export async function checkEvmLendingMcaAccount(
  address: string,
  lookupMcaByWallet: typeof getMcaByWallet = getMcaByWallet
): Promise<string | null> {
  const identityKey = parseEvmAddress(address)
  const mcaId: unknown = await lookupMcaByWallet({ chain: 'evm', identityKey })
  if (mcaId === null) return null
  if (typeof mcaId !== 'string' || mcaId.length === 0) {
    throw new Error('Invalid EVM lending account response')
  }
  return mcaId
}

export { clearLendingMcaCache }

export async function fetchLendingData(mcaId?: string): Promise<LendingData> {
  const result: IBatchViewsWithTransformsResult = await batchViewsData(mcaId)

  const hasAssets = result.assetsView && Object.keys(result.assetsView).length > 0
  const zecAsset = result.assetsView?.[ZEC_NEAR_TOKEN_ID]
  const hasValidPrice = zecAsset?.price?.usd && safeBig(zecAsset.price.usd).gt(0)

  if (!hasAssets || !hasValidPrice || !result.config) {
    throw new Error('Lending data unavailable (RPC may be rate-limited)')
  }

  if (mcaId && !result.portfolioView) {
    throw new Error('Portfolio data unavailable (RPC may be rate-limited)')
  }

  return {
    assetsView: result.assetsView,
    portfolioView: result.portfolioView,
    config: result.config
  }
}

export function getUnclaimedAmount(
  portfolioView: Portfolio | null | undefined,
  assetsView: IAssetsView | null | undefined
) {
  const rewards = getUnclaimedRewards({ portfolioView, assetsView })
  const unclaimedAmount = rewards.reduce(
    (sum, reward) => safeBig(sum).plus(reward.amountToken || '0'),
    safeBig(0)
  )
  const rawAmount = safeBig(unclaimedAmount)
    .plus(portfolioView?.supplied[REWARD_TOKEN_ID]?.balance || '0')
    .toFixed()
  const rewardTokenAssetView = assetsView?.[REWARD_TOKEN_ID]
  const amount = formatAmount(rawAmount, REWARD_TOKEN_ID_DECIMALS)
  const amountUsd = safeBig(amount)
    .times(rewardTokenAssetView?.price.usd || 0)
    .toFixed()
  return { amount, amountUsd, rawAmount }
}

export function setNearRpcUrl(url: string): void {
  setCustomNodeUrl(url)
}

export function getZecAssetData(assetsView: IAssetsView | null) {
  if (!assetsView) return null
  return assetsView[ZEC_NEAR_TOKEN_ID] || null
}

export function getSuppliedAmount(portfolioView: Portfolio | null | undefined): string {
  if (!portfolioView?.supplied) return '0'
  const asset = portfolioView.supplied[ZEC_NEAR_TOKEN_ID]
  return asset?.balance || '0'
}

export function getCollateralAmount(portfolioView: Portfolio | null | undefined): string {
  if (!portfolioView?.collateral) return '0'
  const asset = portfolioView.collateral[ZEC_NEAR_TOKEN_ID]
  return asset?.balance || '0'
}

export interface ApyDetails {
  baseApy: string
  rewardMinApy: string
  rewardMaxApy: string
  totalMinApy: string
  totalMaxApy: string
}

export function getApyDetails(assetsView: IAssetsView | null): ApyDetails {
  const defaultApy = {
    baseApy: '0',
    rewardMinApy: '0',
    rewardMaxApy: '0',
    totalMinApy: '0',
    totalMaxApy: '0'
  }

  if (!assetsView) return defaultApy

  try {
    const farmDetails = getFarmDetailsOfAsset({
      assets: assetsView,
      assetId: ZEC_NEAR_TOKEN_ID
    })

    const baseApy = safeBig(farmDetails.supplyApy)
    const rewardMin = safeBig(farmDetails.minFarmApy)
    const rewardMax = safeBig(farmDetails.maxFarmApy)

    return {
      baseApy: baseApy.toFixed(),
      rewardMinApy: rewardMin.toFixed(),
      rewardMaxApy: rewardMax.toFixed(),
      totalMinApy: baseApy.plus(rewardMin).toFixed(),
      totalMaxApy: baseApy.plus(rewardMax).toFixed()
    }
  } catch (error) {
    console.error('getFarmDetailsOfAsset Error', error)
    return defaultApy
  }
}
