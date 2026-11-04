import { useCallback, useEffect, useRef, useState } from 'react'
import { accountManager } from '@/core/wallet/account-manager'
import { marginalFeeForTier, type FeeQuote, type FeeTier } from '@/config/fee'
import { safeBig } from '@/lib/big'
import type { FundingSource } from '@/types'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'

export interface MaxTransferEstimateState {
  maxAmount: string | null
  fee: string | null
  feeQuote: FeeQuote | null
  loading: boolean
  error: boolean
  feeByTier: Record<FeeTier, number | null>
  loadingByTier: Record<FeeTier, boolean>
  refresh: () => void
}
type TierEstimateState = Pick<
  MaxTransferEstimateState,
  'maxAmount' | 'fee' | 'feeQuote' | 'loading' | 'error' | 'refresh'
>
type InternalState = Omit<TierEstimateState, 'refresh'> & { requestKey: string }

interface UseMaxTransferEstimateArgs {
  to?: string
  memo?: string
  feeTier: FeeTier
  fundingSource?: FundingSource
  enabled?: boolean
  debounceMs?: number
}

/** Builds the same send-max proposal that will be used by the transaction. */
function useMaxTransferEstimateForTier({
  to,
  memo,
  feeTier,
  fundingSource = 'shielded',
  enabled = true,
  debounceMs = 300
}: UseMaxTransferEstimateArgs): TierEstimateState {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const rpcMode = useSettingsStore(state => state.rpcEndpointModes.zcash)
  const rpcPreference = useSettingsStore(state => state.rpcEndpointPreferences.zcash)
  const customRpc = useSettingsStore(state => state.customRpcEndpoints.zcash)
  const [generation, setGeneration] = useState(0)
  const currentBalance = useAccountDataStore(state => state.getCurrentBalance())
  const sourceAvailable = currentBalance?.confirmed?.[fundingSource] ?? '0'
  const [state, setState] = useState<InternalState>({
    maxAmount: null,
    fee: null,
    feeQuote: null,
    loading: false,
    error: false,
    requestKey: ''
  })
  const requestSeq = useRef(0)
  const refresh = useCallback(() => setGeneration(value => value + 1), [])
  const active = enabled && !!to
  const requestKey = JSON.stringify([
    to,
    memo,
    feeTier,
    fundingSource,
    active,
    currentWalletId,
    currentAccountId,
    currentNetwork,
    sourceAvailable,
    rpcMode,
    rpcPreference,
    customRpc,
    generation
  ])

  useEffect(() => {
    const seq = ++requestSeq.current
    if (!active) {
      setState({
        maxAmount: null,
        fee: null,
        feeQuote: null,
        loading: false,
        error: false,
        requestKey
      })
      return
    }

    setState({
      maxAmount: null,
      fee: null,
      feeQuote: null,
      loading: true,
      error: false,
      requestKey
    })
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(async () => {
      try {
        const requestWalletId = currentWalletId
        const requestAccountId = currentAccountId
        const quote = await accountManager.getFeeQuote()
        const estimate = await accountManager.estimateMaxTransfer(
          to!,
          memo,
          marginalFeeForTier(feeTier, quote.standardMarginalFeeZats),
          fundingSource,
          quote.id
        )
        if (seq !== requestSeq.current) return
        if (estimate.feeQuote.id !== quote.id || estimate.feeQuote.expiresAt <= Date.now()) {
          throw new Error('Network fee quote expired')
        }
        if (
          Number(estimate.marginalFeeZats) !==
          marginalFeeForTier(feeTier, estimate.feeQuote.standardMarginalFeeZats)
        ) {
          throw new Error('Estimate does not use the selected network fee')
        }

        const cachedBalance =
          requestWalletId && requestAccountId
            ? useAccountDataStore
                .getState()
                .getBalance(currentNetwork, requestWalletId, requestAccountId)
            : null
        const cachedSourceZats = safeBig(cachedBalance?.confirmed?.[fundingSource] ?? '0').mul(1e8)
        const estimateTotalZats = safeBig(estimate.maxAmountZats).plus(estimate.feeZats)

        if (requestWalletId && estimateTotalZats.gt(cachedSourceZats)) {
          await accountManager.refreshBalances(requestWalletId, true)
        }

        const walletState = useWalletStore.getState()
        if (
          seq !== requestSeq.current ||
          walletState.currentWalletId !== requestWalletId ||
          walletState.currentAccountId !== requestAccountId ||
          walletState.currentNetwork !== currentNetwork
        ) {
          return
        }
        setState({
          maxAmount: safeBig(estimate.maxAmountZats).div(1e8).toFixed(),
          fee: safeBig(estimate.feeZats).div(1e8).toFixed(),
          feeQuote: estimate.feeQuote,
          loading: false,
          error: false,
          requestKey
        })
        expiryTimer = setTimeout(
          () => setGeneration(value => value + 1),
          Math.max(0, estimate.feeQuote.expiresAt - Date.now())
        )
      } catch {
        if (seq !== requestSeq.current) return
        setState({
          maxAmount: null,
          fee: null,
          feeQuote: null,
          loading: false,
          error: true,
          requestKey
        })
      }
    }, debounceMs)

    return () => {
      clearTimeout(timer)
      clearTimeout(expiryTimer)
      requestSeq.current++
    }
  }, [
    to,
    memo,
    feeTier,
    fundingSource,
    active,
    debounceMs,
    currentWalletId,
    currentAccountId,
    currentNetwork,
    sourceAvailable,
    rpcMode,
    rpcPreference,
    customRpc,
    generation,
    requestKey
  ])

  if (state.requestKey !== requestKey) {
    return { maxAmount: null, fee: null, feeQuote: null, loading: active, error: false, refresh }
  }
  return {
    maxAmount: state.maxAmount,
    fee: state.fee,
    feeQuote: state.feeQuote,
    loading: state.loading,
    error: state.error,
    refresh
  }
}

export function useMaxTransferEstimate(args: UseMaxTransferEstimateArgs): MaxTransferEstimateState {
  const standard = useMaxTransferEstimateForTier({ ...args, feeTier: 'standard' })
  const fast = useMaxTransferEstimateForTier({ ...args, feeTier: 'fast' })
  const selected = args.feeTier === 'fast' ? fast : standard
  const refresh = useCallback(() => {
    standard.refresh()
    fast.refresh()
  }, [standard.refresh, fast.refresh])

  return {
    maxAmount: selected.maxAmount,
    fee: selected.fee,
    feeQuote: selected.feeQuote,
    loading: selected.loading,
    error: selected.error,
    feeByTier: {
      standard: standard.fee === null ? null : safeBig(standard.fee).mul(1e8).toNumber(),
      fast: fast.fee === null ? null : safeBig(fast.fee).mul(1e8).toNumber()
    },
    loadingByTier: { standard: standard.loading, fast: fast.loading },
    refresh
  }
}
