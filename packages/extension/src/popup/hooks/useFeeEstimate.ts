import { useCallback, useEffect, useRef, useState } from 'react'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import type { FeeQuote, FeeTier, QuotedFeeEstimate } from '@/config/fee'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { useWalletStore } from '@/store/wallet-store'
import type { FundingSource } from '@/types'

interface TierEstimate {
  feeZats: number | null
  feeQuote: FeeQuote | null
  loading: boolean
  error: boolean
  retry: () => void
}

export interface FeeEstimateState extends TierEstimate {
  feeByTier: Record<FeeTier, number | null>
  loadingByTier: Record<FeeTier, boolean>
}

interface UseFeeEstimateArgs {
  type: 'send' | 'shield'
  to?: string
  amount?: string
  memo?: string
  fundingSource?: FundingSource
  feeTier?: FeeTier
  enabled?: boolean
  debounceMs?: number
  estimate?: (tier: FeeTier) => Promise<QuotedFeeEstimate>
  scopeKey?: string
}

type EstimateState = Omit<TierEstimate, 'retry'> & { key: string }
const emptyEstimate = { feeZats: null, feeQuote: null, loading: false, error: false }

function useEstimateForTier({
  type,
  to,
  amount,
  memo,
  fundingSource = 'shielded',
  feeTier = 'standard',
  enabled = true,
  debounceMs = 500,
  estimate,
  scopeKey
}: UseFeeEstimateArgs): TierEstimate {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const rpcPreference = useSettingsStore(state => state.rpcEndpointPreferences.zcash)
  const rpcScope = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState<EstimateState>({ ...emptyEstimate, key: '' })
  const sequence = useRef(0)
  const retry = useCallback(() => setGeneration(value => value + 1), [])
  const active = enabled && (type === 'shield' || (!!to && !!amount && Number(amount) > 0))
  const key = JSON.stringify([
    type,
    to,
    amount,
    memo,
    fundingSource,
    feeTier,
    active,
    walletId,
    accountId,
    network,
    rpcPreference,
    rpcScope,
    scopeKey,
    generation
  ])

  useEffect(() => {
    const current = ++sequence.current
    if (!active) {
      setState({ ...emptyEstimate, key })
      return
    }
    setState({ ...emptyEstimate, loading: true, key })
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(async () => {
      const startedAt = Date.now()
      let step = 'estimate'
      try {
        let expectedQuoteId: string | undefined
        const result = estimate
          ? await estimate(feeTier)
          : await (async () => {
              step = 'fee quote'
              const quote = await zcashWalletRuntimeClient.getFeeQuote()
              expectedQuoteId = quote.id
              const marginalFeeZats = marginalFeeForTier(feeTier, quote.standardMarginalFeeZats)
              step = 'fee estimate'
              return type === 'shield'
                ? zcashWalletRuntimeClient.estimateShieldFee(marginalFeeZats, quote.id)
                : zcashWalletRuntimeClient.estimateTransferFee({
                    to: to!,
                    amount: amount!,
                    memo,
                    fundingSource,
                    marginalFeeZats,
                    feeQuoteId: quote.id
                  })
            })()
        if (current !== sequence.current) return
        step = 'result check'
        const feeZats = Number(result.feeZats)
        const invalidReason =
          !Number.isSafeInteger(feeZats) || feeZats <= 0
            ? 'fee is not a positive amount'
            : expectedQuoteId !== undefined && result.feeQuote.id !== expectedQuoteId
              ? 'fee quote was replaced'
              : result.feeQuote.expiresAt <= Date.now()
                ? 'fee quote expired'
                : Number(result.marginalFeeZats) !==
                    marginalFeeForTier(feeTier, result.feeQuote.standardMarginalFeeZats)
                  ? 'fee rate does not match the tier'
                  : null
        if (invalidReason) throw new Error(`Invalid network fee estimate: ${invalidReason}`)
        setState({ feeZats, feeQuote: result.feeQuote, loading: false, error: false, key })
        expiryTimer = setTimeout(retry, Math.max(0, result.feeQuote.expiresAt - Date.now()))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `[FeeEstimate] ${feeTier} failed at ${step} after ${Date.now() - startedAt} ms` +
            (current === sequence.current ? '' : ' (already replaced by a newer estimate)') +
            `: ${message.slice(0, 300)}`
        )
        if (current === sequence.current) setState({ ...emptyEstimate, error: true, key })
      }
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      clearTimeout(expiryTimer)
      sequence.current += 1
    }
  }, [active, debounceMs, estimate, feeTier, key, retry, to, amount, memo, fundingSource, type])

  return state.key === key
    ? {
        feeZats: state.feeZats,
        feeQuote: state.feeQuote,
        loading: state.loading,
        error: state.error,
        retry
      }
    : { ...emptyEstimate, loading: active, retry }
}

/** Each tier keeps the fee produced by its own WASM proposal. */
export function useFeeEstimate(args: UseFeeEstimateArgs): FeeEstimateState {
  const standard = useEstimateForTier({ ...args, feeTier: 'standard' })
  const fast = useEstimateForTier({ ...args, feeTier: 'fast' })
  const selected = args.feeTier === 'fast' ? fast : standard
  const retry = useCallback(() => {
    standard.retry()
    fast.retry()
  }, [standard.retry, fast.retry])
  return {
    ...selected,
    retry,
    feeByTier: { standard: standard.feeZats, fast: fast.feeZats },
    loadingByTier: { standard: standard.loading, fast: fast.loading }
  }
}
