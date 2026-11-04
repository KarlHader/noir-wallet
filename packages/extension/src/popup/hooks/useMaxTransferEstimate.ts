import { useCallback, useEffect, useRef, useState } from 'react'
import {
  zcashWalletRuntimeClient,
  type MaxTransferEstimate
} from '@/popup/services/zcash-wallet-runtime-client'
import type { FeeQuote, FeeTier } from '@/config/fee'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import type { FundingSource } from '@/types'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { safeBig } from '@/lib/big'

interface TierEstimate {
  maxAmount: string | null
  fee: string | null
  feeQuote: FeeQuote | null
  loading: boolean
  error: boolean
  request: () => Promise<void>
  update: (estimate: MaxTransferEstimate, to: string) => void
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

type EstimateState = Omit<TierEstimate, 'request' | 'update'> & { key: string }
const emptyEstimate = { maxAmount: null, fee: null, feeQuote: null, loading: false, error: false }

function useMaxForTier({
  to,
  memo,
  feeTier,
  fundingSource = 'shielded',
  enabled = true
}: UseMaxTransferEstimateArgs): TierEstimate {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const rpcPreference = useSettingsStore(state => state.rpcEndpointPreferences.zcash)
  const rpcScope = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const sourceAvailable = getFundingBalance(balance, fundingSource).available
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState<EstimateState>({ ...emptyEstimate, key: '' })
  const sequence = useRef(0)
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = enabled && !!to
  const scope = JSON.stringify([
    memo,
    feeTier,
    fundingSource,
    enabled,
    walletId,
    accountId,
    network,
    sourceAvailable,
    rpcPreference,
    rpcScope,
    generation
  ])
  const key = JSON.stringify([to, scope])

  const request = useCallback(async () => {
    if (!active || !to) return
    const current = ++sequence.current
    clearTimeout(expiryTimer.current)
    setState({ ...emptyEstimate, loading: true, key })
    try {
      const quote = await zcashWalletRuntimeClient.getFeeQuote()
      const estimate = await zcashWalletRuntimeClient.estimateMaxTransfer({
        to,
        memo,
        fundingSource,
        marginalFeeZats: marginalFeeForTier(feeTier, quote.standardMarginalFeeZats),
        feeQuoteId: quote.id
      })
      if (current !== sequence.current) return
      if (
        estimate.feeQuote.id !== quote.id ||
        estimate.feeQuote.expiresAt <= Date.now() ||
        Number(estimate.marginalFeeZats) !==
          marginalFeeForTier(feeTier, estimate.feeQuote.standardMarginalFeeZats)
      )
        throw new Error('Invalid maximum transfer fee estimate')
      setState({
        key,
        maxAmount: formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS),
        fee: formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS),
        feeQuote: estimate.feeQuote,
        loading: false,
        error: false
      })
      expiryTimer.current = setTimeout(
        () => setGeneration(value => value + 1),
        Math.max(0, estimate.feeQuote.expiresAt - Date.now())
      )
    } catch {
      if (current === sequence.current) setState({ ...emptyEstimate, error: true, key })
    }
  }, [active, to, memo, fundingSource, feeTier, key])

  useEffect(() => {
    const timer = active ? setTimeout(() => void request(), 300) : undefined
    if (!active) setState({ ...emptyEstimate, key })
    return () => {
      clearTimeout(timer)
      clearTimeout(expiryTimer.current)
      sequence.current += 1
    }
  }, [active, key, request])

  const update = useCallback(
    (estimate: MaxTransferEstimate, target: string) => {
      sequence.current += 1
      clearTimeout(expiryTimer.current)
      const targetKey = JSON.stringify([target, scope])
      try {
        if (
          !estimate.feeQuote ||
          estimate.feeQuote.expiresAt <= Date.now() ||
          Number(estimate.marginalFeeZats) !==
            marginalFeeForTier(feeTier, estimate.feeQuote.standardMarginalFeeZats)
        )
          throw new Error('Invalid maximum transfer fee estimate')
        setState({
          key: targetKey,
          maxAmount: formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS),
          fee: formatBaseUnitDecimalAmount(estimate.feeZats, ZEC_DECIMALS),
          feeQuote: estimate.feeQuote,
          loading: false,
          error: false
        })
        expiryTimer.current = setTimeout(
          () => setGeneration(value => value + 1),
          Math.max(0, estimate.feeQuote.expiresAt - Date.now())
        )
      } catch {
        setState({ ...emptyEstimate, error: true, key: targetKey })
      }
    },
    [feeTier, scope]
  )

  return state.key === key
    ? { ...state, request, update }
    : { ...emptyEstimate, loading: active, request, update }
}

/** Keep both Max proposal fees while selecting the amount for the active tier. */
export function useMaxTransferEstimate(args: UseMaxTransferEstimateArgs): MaxTransferEstimateState {
  const standard = useMaxForTier({ ...args, feeTier: 'standard' })
  const fast = useMaxForTier({ ...args, feeTier: 'fast' })
  const selected = args.feeTier === 'fast' ? fast : standard
  return {
    ...selected,
    feeByTier: {
      standard: standard.fee === null ? null : safeBig(standard.fee).mul(1e8).toNumber(),
      fast: fast.fee === null ? null : safeBig(fast.fee).mul(1e8).toNumber()
    },
    loadingByTier: { standard: standard.loading, fast: fast.loading }
  }
}
