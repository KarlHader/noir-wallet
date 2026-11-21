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
import { useQuoteReview, useQuoteReviewTimer } from './useQuoteReview'
import { nativeZecQuoteTerms } from '@/popup/services/quote-review'

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
  const { begin, stage, reset, accept, isAccepted, describe } = useQuoteReview()
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const submittingQuoteId = useRef<string | null>(null)
  const reviewScope =
    scope && safeBig(amount || '0').gt(0) && (reviewing || safeBig(amount || '0').lte(available))
      ? JSON.stringify([
          scope.network,
          scope.walletId,
          scope.accountId,
          scope.fundingSource,
          scope.refundAddress,
          amount
        ])
      : null
  const key = reviewScope ? JSON.stringify([reviewScope, retryCount]) : null
  const ready = Boolean(key && quote?.key === key && quote.review.expiresAt > Date.now() + 5_000)
  const reviewedQuote = reviewing && ready ? (quote?.review ?? null) : null
  const reviewStatus = describe(reviewScope, reviewedQuote?.quoteId ?? null)
  const reviewReady = Boolean(reviewedQuote && isAccepted(reviewScope, reviewedQuote.quoteId))
  const loading = Boolean(key && !ready && !error)
  const retry = () => {
    if (!confirmationInFlight.current) setRetryCount(value => value + 1)
  }
  useQuoteReviewTimer({
    active: Boolean(quote?.key === key && !confirmationInFlight.current),
    expiresAt: quote?.review.expiresAt ?? null,
    refresh: !reviewing || reviewReady ? retry : undefined,
    autoRefreshMs: Number.POSITIVE_INFINITY
  })
  useEffect(() => {
    if (!reviewing) reset()
    else if (reviewScope && reviewedQuote) {
      stage(reviewScope, {
        id: reviewedQuote.quoteId,
        terms: nativeZecQuoteTerms(reviewedQuote),
        expiresAt: reviewedQuote.expiresAt
      })
    }
  }, [reviewing, reviewScope, reviewedQuote, reset, stage])

  useEffect(() => {
    setQuote(null)
    setError(null)
    if (!key || !scope) return
    const { network, walletId, accountId, fundingSource, refundAddress } = scope
    const assetId = `${getZcashChainId(network)}/slip44:133`
    let cancelled = false
    let preparedQuoteId: string | null = null
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
            setError('Quote changed. Try again.')
            return
          }
          setQuote({ key, review })
        })
        .catch(cause => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'Quote unavailable')
        })
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (preparedQuoteId && submittingQuoteId.current !== preparedQuoteId)
        void cancelNativeZecIntentsSwap(preparedQuoteId).catch(() => {})
    }
  }, [key])

  return {
    quote,
    reviewedQuote,
    reviewStatus,
    beginReview: () => {
      if (ready && quote && reviewScope) begin(reviewScope, nativeZecQuoteTerms(quote.review))
    },
    acceptReview: () => {
      if (reviewedQuote) accept(reviewScope, reviewedQuote.quoteId)
    },
    error,
    ready,
    reviewReady,
    loading,
    submittingQuoteId,
    invalidate: () => {
      setQuote(null)
      setError('Quote changed. Try again.')
    },
    retry
  }
}
