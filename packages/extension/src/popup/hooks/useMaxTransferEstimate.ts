import { useCallback, useEffect, useRef, useState } from 'react'
import {
  zcashWalletRuntimeClient,
  type MaxTransferEstimate
} from '@/popup/services/zcash-wallet-runtime-client'
import type { FeeTier } from '@/config/fee'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import type { FundingSource } from '@/types'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { getFundingBalance } from '@/core/wallet/funding-balance'

export interface MaxTransferEstimateState {
  maxAmount: string | null
  fee: string | null
  loading: boolean
  error: boolean
}

interface UseMaxTransferEstimateArgs {
  to?: string
  memo?: string
  feeTier: FeeTier
  fundingSource?: FundingSource
  enabled?: boolean
}

/** Builds the same send-max proposal that will be used by the transaction. */
export function useMaxTransferEstimate({
  to,
  memo,
  feeTier,
  fundingSource = 'shielded',
  enabled = true
}: UseMaxTransferEstimateArgs): MaxTransferEstimateState & {
  request: () => Promise<void>
  update: (estimate: MaxTransferEstimate, to: string) => void
} {
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const sourceAvailable = getFundingBalance(balance, fundingSource).available
  const [state, setState] = useState<MaxTransferEstimateState & { key: string }>({
    key: '',
    maxAmount: null,
    fee: null,
    loading: false,
    error: false
  })
  const requestSeq = useRef(0)
  const scope = JSON.stringify([
    memo,
    feeTier,
    fundingSource,
    enabled,
    currentWalletId,
    currentAccountId,
    currentNetwork,
    sourceAvailable
  ])
  const requestKey = JSON.stringify([to, scope])
  const latest = useRef({ to, memo, feeTier, fundingSource, enabled, scope, key: requestKey })
  latest.current = { to, memo, feeTier, fundingSource, enabled, scope, key: requestKey }
  useEffect(() => {
    requestSeq.current += 1
    const resolved = state.key === requestKey && state.maxAmount !== null
    const timer = !resolved && enabled && to ? setTimeout(() => void request(), 300) : undefined
    return () => {
      clearTimeout(timer)
      requestSeq.current += 1
    }
  }, [requestKey])

  const update = useCallback((estimate: MaxTransferEstimate, target: string) => {
    requestSeq.current += 1
    const key = JSON.stringify([target, latest.current.scope])
    try {
      const maxAmount = formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS)
      const fee = formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS)
      setState({ key, maxAmount, fee, loading: false, error: false })
    } catch {
      setState({ key, maxAmount: null, fee: null, loading: false, error: true })
    }
  }, [])

  const request = async () => {
    const input = latest.current
    if (!input.enabled || !input.to) return
    const seq = ++requestSeq.current
    setState({ key: input.key, maxAmount: null, fee: null, loading: true, error: false })
    try {
      const estimate = await zcashWalletRuntimeClient.estimateMaxTransfer({
        to: input.to,
        memo: input.memo,
        marginalFeeZats: marginalFeeForTier(input.feeTier),
        fundingSource: input.fundingSource
      })
      if (seq !== requestSeq.current || input.key !== latest.current.key) return
      setState({
        key: input.key,
        maxAmount: formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS),
        fee: formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS),
        loading: false,
        error: false
      })
    } catch {
      if (seq !== requestSeq.current || input.key !== latest.current.key) return
      setState({ key: input.key, maxAmount: null, fee: null, loading: false, error: true })
    }
  }

  return state.key === requestKey
    ? { ...state, request, update }
    : { maxAmount: null, fee: null, loading: false, error: false, request, update }
}
