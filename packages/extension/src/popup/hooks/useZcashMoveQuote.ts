import { useEffect, useRef, useState, type RefObject } from 'react'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { getZcashChainId } from '@/core/chains/registry'
import { zecToZats } from '@/core/services/native-zec-intents-swap'
import { safeBig } from '@/lib/big'
import {
  cancelNativeZecIntentsSwap,
  prepareNativeZecIntentsSwap,
  type NativeZecIntentsSwapReview
} from '@/popup/services/native-zec-intents-swap-client'
import type { FundingSource, Network } from '@/types'

type MoveQuoteScope = Readonly<{
  network: Network
  walletId: string
  accountId: string
  fundingSource: FundingSource
  refundAddress: string
}>

export function useZcashMoveQuote({
  scope,
  amount,
  available,
  reviewing,
  confirmationInFlight
}: {
  readonly scope: MoveQuoteScope | null
  readonly amount: string
  readonly available: string
  readonly reviewing: boolean
  readonly confirmationInFlight: RefObject<boolean>
}) {
  const [quote, setQuote] = useState<{ key: string; review: NativeZecIntentsSwapReview } | null>(
    null
  )
  const [reviewedQuote, setReviewedQuote] = useState<NativeZecIntentsSwapReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const submittingQuoteId = useRef<string | null>(null)
  const reviewingRef = useRef(reviewing)
  reviewingRef.current = reviewing

  const key =
    scope && safeBig(amount || '0').gt(0) && (reviewing || safeBig(amount || '0').lte(available))
      ? JSON.stringify([
          scope.network,
          scope.walletId,
          scope.accountId,
          scope.fundingSource,
          scope.refundAddress,
          amount,
          retryCount
        ])
      : null
  const ready = Boolean(key && quote?.key === key && quote.review.expiresAt > Date.now() + 5_000)
  const reviewReady = Boolean(ready && reviewedQuote?.quoteId === quote?.review.quoteId)
  const loading = Boolean(key && !ready && !error)

  useEffect(() => {
    setQuote(null)
    setError(null)
    if (!key || !scope) return
    const { network, walletId, accountId, fundingSource, refundAddress } = scope
    const assetId = `${getZcashChainId(network)}/slip44:133`
    let cancelled = false
    let preparedQuoteId: string | null = null
    let expiryTimer: number | undefined
    const timer = window.setTimeout(() => {
      let amountZats: string
      try {
        amountZats = zecToZats(amount)
        if (BigInt(amountZats) <= 0n) return
      } catch {
        return
      }
      void prepareNativeZecIntentsSwap({
        network,
        walletId,
        accountId,
        amountZats,
        destination: {
          chainId: getZcashChainId(network),
          assetId,
          protocolAssetId: ZEC_ZCASH_ASSET
        },
        refundAddress,
        recipientType: 'CONFIDENTIAL_INTENTS',
        fundingSource,
        slippageBps: 50
      })
        .then(review => {
          preparedQuoteId = review.quoteId
          if (cancelled) {
            void cancelNativeZecIntentsSwap(review.quoteId).catch(() => {})
            return
          }
          if (
            review.network !== network ||
            review.walletId !== walletId ||
            review.accountId !== accountId ||
            review.amountZats !== amountZats ||
            review.destination.assetId !== assetId ||
            review.recipientType !== 'CONFIDENTIAL_INTENTS' ||
            review.fundingSource !== fundingSource ||
            review.expiresAt <= Date.now() + 5_000
          ) {
            void cancelNativeZecIntentsSwap(review.quoteId).catch(() => {})
            setError('Move quote changed. Try again.')
            return
          }
          setQuote({ key, review })
          expiryTimer = window.setTimeout(
            () => {
              if (reviewingRef.current || confirmationInFlight.current) {
                setError('Move quote expired. Try again.')
                return
              }
              setRetryCount(value => value + 1)
            },
            Math.max(0, review.expiresAt - Date.now() - 5_000)
          )
        })
        .catch(cause => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : 'Move quote unavailable')
        })
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      if (preparedQuoteId && submittingQuoteId.current !== preparedQuoteId)
        void cancelNativeZecIntentsSwap(preparedQuoteId).catch(() => {})
    }
  }, [key])

  return {
    quote,
    reviewedQuote,
    setReviewedQuote,
    error,
    ready,
    reviewReady,
    loading,
    submittingQuoteId,
    invalidate: () => {
      setQuote(null)
      setError('Move quote changed. Try again.')
    },
    retry: () => setRetryCount(value => value + 1)
  }
}
