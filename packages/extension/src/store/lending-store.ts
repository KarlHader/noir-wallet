import { create } from 'zustand'
import type { IAssetsView, Portfolio, IConfig, Asset } from '@rhea-finance/cross-chain-sdk'
import {
  checkEvmLendingMcaAccount,
  checkLendingMcaAccount,
  fetchLendingData,
  getUnclaimedAmount,
  getZecAssetData,
  getSuppliedAmount,
  getCollateralAmount,
  getApyDetails,
  type ApyDetails,
  type LendingSigningMode
} from '@/core/services/lending-service'
import { lendingIdentityClient } from '@/popup/services/lending-identity-client'
import { clearLendingMcaCache } from '@/core/services/lending-mca-cache'
import { useWalletStore } from './wallet-store'
import { safeBig } from '@/lib/big'
import { formatAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import Big from 'big.js'
import type { Network } from '@/types'
import { DedupPromise } from '@/lib/async-utils'
import {
  getLendingBalanceDecimals,
  getLendingMarketViews,
  type LendingMarketView
} from '@/core/services/lending-market-catalog'
import {
  readLendingMarketCache,
  writeLendingMarketCache
} from '@/infrastructure/lending/chrome-lending-market-cache'

const LIVE_DATA_REUSE_MS = 60_000
const refreshDedups = new Map<string, DedupPromise<void>>()

export type LendingAccountContext = Readonly<{
  walletId: string
  accountId: string
  network: Network
  identity: Readonly<{ kind: 'zcash' }> | Readonly<{ kind: 'evm'; address: string }>
}>

export function getLendingAccountScope(context: LendingAccountContext): string {
  if (!context.walletId || !context.accountId) {
    throw new Error('Lending account identity is unavailable')
  }
  return `${context.walletId}:${context.accountId}:${context.network}`
}

interface LendingStore {
  accountScope: string | null
  refreshGeneration: number
  mcaId: string | null
  publicKey: string | null
  signingMode: LendingSigningMode
  isCheckingMca: boolean
  mcaChecked: boolean

  assetsView: IAssetsView | null
  portfolioView: Portfolio | undefined
  config: IConfig | null
  isLoadingData: boolean
  dataLoaded: boolean
  lastRefreshedAt: number | null
  cachedMarketAssets: readonly LendingMarketView[]

  unclaimedAmount: {
    amount: string
    amountUsd: string
    rawAmount: string
  }

  error: string | null
  mcaError: string | null

  checkMcaStatus: (context: LendingAccountContext) => Promise<void>
  fetchLendingData: () => Promise<void>
  refreshAll: (
    context: LendingAccountContext,
    options?: { forceMcaCheck?: boolean }
  ) => Promise<void>
  hydrateMarketCache: (context: LendingAccountContext) => Promise<void>
  invalidateMcaStatus: (context: LendingAccountContext) => void
  reset: () => void

  getZecAsset: () => Asset | null
  getSupplyApy: () => string
  getApyDetails: () => ApyDetails
  getFormattedSupplied: () => string
  getDailyRewardsUsd: () => string
  getSuppliedZec: () => string
  getCollateralZec: () => string
  getTotalSuppliedZec: () => string
  hasMca: () => boolean
  getMarketAssets: () => readonly LendingMarketView[]
  getUserSuppliedUsd: () => string
  getNetApy: () => string
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 2000): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

export const useLendingStore = create<LendingStore>()((set, get) => ({
  accountScope: null,
  refreshGeneration: 0,
  mcaId: null,
  publicKey: null,
  signingMode: 'derived' as LendingSigningMode,
  isCheckingMca: false,
  mcaChecked: false,

  assetsView: null,
  portfolioView: undefined,
  config: null,
  isLoadingData: false,
  dataLoaded: false,
  lastRefreshedAt: null,
  cachedMarketAssets: Object.freeze([]),

  unclaimedAmount: {
    amount: '0',
    amountUsd: '0',
    rawAmount: '0'
  },

  error: null,
  mcaError: null,

  checkMcaStatus: async context => {
    const accountScope = getLendingAccountScope(context)
    const refreshGeneration = get().refreshGeneration
    set({ isCheckingMca: true, mcaError: null })

    try {
      const result = await withRetry(() =>
        context.identity.kind === 'evm'
          ? checkEvmLendingMcaAccount(context.identity.address).then(mcaId => ({
              mcaId,
              publicKey: null,
              signingMode: 'derived' as const
            }))
          : checkLendingMcaAccount(context.walletId, context.accountId, mode =>
              lendingIdentityClient.getZcashPublicKey(context.walletId, context.accountId, mode)
            )
      )
      if (get().accountScope !== accountScope || get().refreshGeneration !== refreshGeneration) {
        return
      }

      set({
        mcaId: result.mcaId,
        publicKey: result.publicKey,
        signingMode: result.signingMode,
        isCheckingMca: false,
        mcaChecked: true,
        mcaError: null
      })
    } catch (err) {
      if (get().accountScope !== accountScope || get().refreshGeneration !== refreshGeneration) {
        return
      }
      console.error('[LendingStore] checkMcaStatus failed:', err)
      set({
        isCheckingMca: false,
        mcaChecked: false,
        mcaError: err instanceof Error ? err.message : 'Failed to check lending account status'
      })
    }
  },

  fetchLendingData: async () => {
    const { mcaId, accountScope, refreshGeneration } = get()

    set({ isLoadingData: true, error: null })

    try {
      const data = await withRetry(() => fetchLendingData(mcaId || undefined))
      const unclaimedAmount = getUnclaimedAmount(data.portfolioView, data.assetsView)
      const marketAssets = getLendingMarketViews(data.assetsView, data.portfolioView)
      if (get().accountScope !== accountScope || get().refreshGeneration !== refreshGeneration) {
        return
      }

      set({
        assetsView: data.assetsView,
        portfolioView: data.portfolioView,
        config: data.config,
        unclaimedAmount,
        cachedMarketAssets: marketAssets,
        isLoadingData: false,
        dataLoaded: true,
        lastRefreshedAt: Date.now()
      })
      if (accountScope) {
        await writeLendingMarketCache(accountScope, marketAssets).catch(error => {
          console.warn('[LendingStore] Failed to persist market cache:', error)
        })
      }
    } catch (err) {
      if (get().accountScope !== accountScope || get().refreshGeneration !== refreshGeneration) {
        return
      }
      console.error('[LendingStore] fetchLendingData failed:', err)
      set({
        isLoadingData: false,
        error: err instanceof Error ? err.message : 'Failed to load lending data'
      })
    }
  },

  refreshAll: async (context, options) => {
    const refreshKey = getLendingAccountScope(context)
    if (get().accountScope !== refreshKey) {
      get().reset()
      set({ accountScope: refreshKey, isCheckingMca: true })
    }
    const refreshGeneration = get().refreshGeneration
    const dedupKey = `${refreshKey}:${refreshGeneration}`

    let refreshDedup = refreshDedups.get(dedupKey)
    if (!refreshDedup) {
      refreshDedup = new DedupPromise<void>()
      refreshDedups.set(dedupKey, refreshDedup)
    }

    await refreshDedup.run(async () => {
      if (!get().dataLoaded) {
        const cachedMarkets = await readLendingMarketCache(refreshKey)
        if (get().accountScope !== refreshKey || get().refreshGeneration !== refreshGeneration)
          return
        if (cachedMarkets.length > 0) {
          set({ cachedMarketAssets: cachedMarkets, dataLoaded: true })
        }
      }
      const lastRefreshedAt = get().lastRefreshedAt
      const canReuseLiveData =
        !options?.forceMcaCheck &&
        get().mcaChecked &&
        lastRefreshedAt !== null &&
        Date.now() - lastRefreshedAt < LIVE_DATA_REUSE_MS
      if (canReuseLiveData) return
      const shouldCheckMca = !get().mcaChecked || options?.forceMcaCheck
      let loadedMarketPreview = false
      if (shouldCheckMca) {
        if (options?.forceMcaCheck && context.identity.kind === 'zcash') {
          clearLendingMcaCache(context.walletId, context.accountId)
        }
        const mcaCheck = get().checkMcaStatus(context)
        if (!get().dataLoaded) {
          loadedMarketPreview = true
          await get().fetchLendingData()
        }
        await mcaCheck
      }
      if (get().accountScope !== refreshKey || get().refreshGeneration !== refreshGeneration) return
      if (!loadedMarketPreview || get().mcaId) {
        await get().fetchLendingData()
      }
    })

    if (!refreshDedup.isPending) {
      refreshDedups.delete(dedupKey)
    }
  },

  hydrateMarketCache: async context => {
    const scope = getLendingAccountScope(context)
    if (get().accountScope !== null && get().accountScope !== scope) get().reset()
    if (get().accountScope === null) set({ accountScope: scope })
    const generation = get().refreshGeneration
    const markets = await readLendingMarketCache(scope)
    if (
      markets.length === 0 ||
      get().accountScope !== scope ||
      get().refreshGeneration !== generation ||
      get().lastRefreshedAt !== null
    ) {
      return
    }
    set({ cachedMarketAssets: markets, dataLoaded: true })
  },

  invalidateMcaStatus: context => {
    if (context.identity.kind === 'zcash') {
      clearLendingMcaCache(context.walletId, context.accountId)
    }
    set({ mcaChecked: false })
  },

  reset: () =>
    set({
      accountScope: null,
      refreshGeneration: get().refreshGeneration + 1,
      mcaId: null,
      publicKey: null,
      signingMode: 'derived' as LendingSigningMode,
      isCheckingMca: false,
      mcaChecked: false,
      assetsView: null,
      portfolioView: undefined,
      config: null,
      isLoadingData: false,
      dataLoaded: false,
      lastRefreshedAt: null,
      cachedMarketAssets: Object.freeze([]),
      unclaimedAmount: {
        amount: '0',
        amountUsd: '0',
        rawAmount: '0'
      },
      error: null,
      mcaError: null
    }),

  getZecAsset: () => getZecAssetData(get().assetsView),

  getSupplyApy: () => {
    return get().getApyDetails().baseApy
  },

  getApyDetails: () => {
    return getApyDetails(get().assetsView)
  },

  getFormattedSupplied: () => {
    const decimals = getLendingBalanceDecimals(get().getZecAsset())
    if (decimals === null) return '0'
    const raw = get().getTotalSuppliedZec()
    const formatted = formatAmount(raw, decimals)

    return safeBig(formatted).round(ZEC_DECIMALS, Big.roundDown).toFixed()
  },

  getDailyRewardsUsd: () => {
    const supplied = get().getFormattedSupplied()
    const apyDetails = get().getApyDetails()
    const zecPrice = useWalletStore.getState().zecPrice
    return safeBig(supplied)
      .times(apyDetails.totalMinApy)
      .div(100)
      .div(365)
      .times(zecPrice)
      .toFixed()
  },

  getSuppliedZec: () => {
    const val = getSuppliedAmount(get().portfolioView)
    return val
  },

  getCollateralZec: () => {
    const val = getCollateralAmount(get().portfolioView)
    return val
  },

  getTotalSuppliedZec: () => {
    const supplied = get().getSuppliedZec()
    const collateral = get().getCollateralZec()
    const total = safeBig(supplied).plus(collateral).toFixed()
    return safeBig(total).gt(0) ? total : '0'
  },

  hasMca: () => !!get().mcaId,

  getMarketAssets: () => {
    return get().assetsView
      ? getLendingMarketViews(get().assetsView, get().portfolioView)
      : get().cachedMarketAssets
  },

  getUserSuppliedUsd: () => {
    const supplied = get().getFormattedSupplied()
    const zecPrice = useWalletStore.getState().zecPrice
    return safeBig(supplied).times(zecPrice).toFixed()
  },

  getNetApy: () => {
    const supplied = get().getFormattedSupplied()
    if (safeBig(supplied).eq(0)) return '0'
    const apy = get().getApyDetails()
    return apy.totalMinApy
  }
}))
