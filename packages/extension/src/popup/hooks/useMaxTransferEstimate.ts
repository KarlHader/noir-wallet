import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeeQuote, FeeTier } from '@/config/fee'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import type { FundingSource } from '@/types'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { safeBig } from '@/lib/big'
import type { MaxTransferEstimate } from '@/popup/services/zcash-wallet-runtime-client'
import {
  MaxTransferEstimateCache,
  type MaxTransferContext
} from '@/popup/services/max-transfer-estimate-cache'

interface TierEstimate {
  maxAmount: string | null
  fee: string | null
  feeQuote: FeeQuote | null
  loading: boolean
  error: boolean
  request: (refresh?: boolean) => Promise<void>
  update: (estimate: MaxTransferEstimate, to: string) => void
  estimateForTarget: (to: string) => Promise<MaxTransferEstimate | null>
}

export interface MaxTransferEstimateState extends TierEstimate {
  feeByTier: Record<FeeTier, number | null>
  loadingByTier: Record<FeeTier, boolean>
}

interface UseMaxTransferEstimateArgs {
  to?: string
  memo?: string
  feeTier: FeeTier
  fundingSource?: FundingSource
  enabled?: boolean
}

function tierState(
  cache: MaxTransferEstimateCache,
  to: string | undefined,
  tier: FeeTier,
  active: boolean
): Pick<TierEstimate, 'maxAmount' | 'fee' | 'feeQuote' | 'loading' | 'error'> {
  if (!active || !to)
    return { maxAmount: null, fee: null, feeQuote: null, loading: false, error: false }
  const { estimate, error } = cache.peek(to, tier)
  return {
    maxAmount: estimate ? formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS) : null,
    fee: estimate ? formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS) : null,
    feeQuote: estimate?.feeQuote ?? null,
    loading: !estimate && !error,
    error
  }
}

/** Keep both tier fees available while prioritizing the selected Max proposal. */
export function useMaxTransferEstimate({
  to,
  memo,
  feeTier,
  fundingSource = 'shielded',
  enabled = true
}: UseMaxTransferEstimateArgs): MaxTransferEstimateState {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const rpcPreference = useSettingsStore(state => state.rpcEndpointPreferences.zcash)
  const rpcScope = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const sourceBalance = getFundingBalance(balance, fundingSource)
  const context: MaxTransferContext = {
    memo,
    fundingSource,
    enabled,
    walletId,
    accountId,
    network,
    available: sourceBalance.available,
    pending: sourceBalance.pending,
    rpcPreference,
    rpcScope
  }
  const mountedRef = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const [, setVersion] = useState(0)
  const [generation, setGeneration] = useState(0)
  const cacheRef = useRef<MaxTransferEstimateCache | null>(null)
  if (!cacheRef.current) {
    cacheRef.current = new MaxTransferEstimateCache(context, () => {
      if (mountedRef.current && enabledRef.current) setVersion(value => value + 1)
    })
  } else cacheRef.current.setContext(context)
  const cache = cacheRef.current
  const scopeKey = cache.scopeKey
  const active = enabled && !!to
  const selectedRequestRef = useRef('')
  selectedRequestRef.current = JSON.stringify([scopeKey, to, feeTier])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const estimateForTarget = useCallback(
    (target: string) =>
      cache.scopeKey === scopeKey ? cache.get(target, feeTier, true) : Promise.resolve(null),
    [cache, feeTier, scopeKey]
  )
  const request = useCallback(
    async (refresh = false) => {
      if (!to || cache.scopeKey !== scopeKey) return
      const pending = cache.get(to, feeTier, true, refresh)
      if (refresh && mountedRef.current && enabledRef.current) {
        setGeneration(value => value + 1)
      }
      await pending
    },
    [cache, feeTier, scopeKey, to]
  )
  const update = useCallback(
    (estimate: MaxTransferEstimate, target: string) => {
      if (cache.scopeKey === scopeKey) cache.update(target, feeTier, estimate)
    },
    [cache, feeTier, scopeKey]
  )

  useEffect(() => {
    if (!active || !to) return
    const selectedRequest = selectedRequestRef.current
    const timer = setTimeout(() => {
      if (cache.scopeKey !== scopeKey) return
      void cache.get(to, feeTier).then(() => {
        if (!mountedRef.current || selectedRequestRef.current !== selectedRequest) return
        const otherTier = feeTier === 'standard' ? 'fast' : 'standard'
        void cache.get(to, otherTier)
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [active, cache, scopeKey, feeTier, generation, to])

  const selected = tierState(cache, to, feeTier, active)
  useEffect(() => {
    if (!selected.feeQuote) return
    const timer = setTimeout(
      () => setGeneration(value => value + 1),
      Math.max(0, selected.feeQuote.expiresAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [selected.feeQuote])

  const standard = tierState(cache, to, 'standard', active)
  const fast = tierState(cache, to, 'fast', active)
  return {
    ...selected,
    request,
    update,
    estimateForTarget,
    feeByTier: {
      standard: standard.fee === null ? null : safeBig(standard.fee).mul(1e8).toNumber(),
      fast: fast.fee === null ? null : safeBig(fast.fee).mul(1e8).toNumber()
    },
    loadingByTier: { standard: standard.loading, fast: fast.loading }
  }
}
