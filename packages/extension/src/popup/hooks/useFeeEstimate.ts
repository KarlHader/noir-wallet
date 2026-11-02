import { useCallback, useEffect, useRef, useState } from 'react'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { MARGINAL_FEE_ZATS } from '@/config/fee'
import type { FundingSource } from '@/types'

export interface FeeEstimateState {
  /** Standard-tier fee in zatoshis (null while pending/failed); other tiers derive from it. */
  feeZats: number | null
  loading: boolean
  /** True when live estimation failed. */
  error: boolean
  retry: () => void
}

interface UseFeeEstimateArgs {
  type: 'send' | 'shield'
  to?: string
  amount?: string
  memo?: string
  fundingSource?: FundingSource
  /** Gate estimation until inputs are valid (e.g. review screen open). */
  enabled?: boolean
  debounceMs?: number
  estimate?: () => Promise<string>
  /** Additional account or balance identity that invalidates an old proposal. */
  scopeKey?: string
}

/**
 * Live network-fee estimation via a WASM transfer proposal.
 *
 * Always estimates the Standard tier (one proposal build); other tiers scale
 * linearly with the marginal fee and are derived by callers, so switching tier
 * never re-runs WASM. Debounced and guarded against stale responses.
 */
export function useFeeEstimate({
  type,
  to,
  amount,
  memo,
  fundingSource = 'shielded',
  enabled = true,
  debounceMs = 500,
  estimate,
  scopeKey
}: UseFeeEstimateArgs): FeeEstimateState {
  const [state, setState] = useState<Omit<FeeEstimateState, 'retry'> & { key: string }>({
    key: '',
    feeZats: null,
    loading: false,
    error: false
  })
  const requestSeq = useRef(0)
  const [retryCount, setRetryCount] = useState(0)
  const retry = useCallback(() => setRetryCount(value => value + 1), [])

  const hasAmount = type === 'shield' || (!!to && !!amount && Number(amount) > 0)
  const active = enabled && hasAmount
  const requestKey = JSON.stringify([
    type,
    to,
    amount,
    memo,
    fundingSource,
    active,
    scopeKey,
    retryCount
  ])

  useEffect(() => {
    const seq = ++requestSeq.current
    if (!active) {
      setState({ key: requestKey, feeZats: null, loading: false, error: false })
      return
    }

    setState({ key: requestKey, feeZats: null, loading: true, error: false })

    const timer = setTimeout(async () => {
      try {
        const feeStr = estimate
          ? await estimate()
          : type === 'shield'
            ? await zcashWalletRuntimeClient.estimateShieldFee(MARGINAL_FEE_ZATS.standard)
            : await zcashWalletRuntimeClient.estimateTransferFee({
                to: to!,
                amount: amount!,
                memo,
                marginalFeeZats: MARGINAL_FEE_ZATS.standard,
                fundingSource
              })

        if (seq !== requestSeq.current) return
        const feeZats = Number(feeStr)
        if (!Number.isSafeInteger(feeZats) || feeZats <= 0) throw new Error('Invalid fee estimate')
        setState({ key: requestKey, feeZats, loading: false, error: false })
      } catch {
        if (seq !== requestSeq.current) return
        setState({ key: requestKey, feeZats: null, loading: false, error: true })
      }
    }, debounceMs)

    return () => {
      clearTimeout(timer)
      requestSeq.current += 1
    }
  }, [requestKey, active, debounceMs, estimate])

  return state.key === requestKey
    ? { feeZats: state.feeZats, loading: state.loading, error: state.error, retry }
    : { feeZats: null, loading: active, error: false, retry }
}
