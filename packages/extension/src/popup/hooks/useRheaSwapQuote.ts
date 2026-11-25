import { useEffect, useRef, type RefObject } from 'react'
import type { RheaSwapQuoteView, RheaSwapReviewView } from '@/core/services/rhea-swap'
import { isRheaSwapQuoteFresh } from '@/core/services/rhea-swap/rhea-swap-quote-validity'
import { logger } from '@/lib/logger'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { getRheaSwapQuoteFailure, rheaSwapClient } from '@/popup/services/rhea-swap-client'
import {
  isSwapQuoteRefreshReady,
  type buildLiveSwapQuoteRequest,
  type SwapQuoteRefreshTarget
} from '@/popup/services/swap-page-model'

const QUOTE_DEBOUNCE_MS = 800

interface RheaSwapQuoteOptions {
  viewStep: 'input' | 'review' | 'approval-pending'
  scopeKey: string
  request: ReturnType<typeof buildLiveSwapQuoteRequest>
  purpose: Parameters<typeof rheaSwapClient.quote>[1]
  fundingSource: Parameters<typeof rheaSwapClient.quote>[2]
  refreshTick: number
  currentQuote: RheaSwapQuoteView | null
  currentKey: string | null
  outputDecimals: number | undefined
  immediate: boolean
  walletId: string | null
  accountId: string | null
  sequence: RefObject<number>
  lastRequestedKey: RefObject<string | null>
  reviewRefreshTarget: RefObject<SwapQuoteRefreshTarget | null>
  autoReviewStartedScope: RefObject<string | null>
  setQuote: (quote: RheaSwapQuoteView | null) => void
  setReview: (review: RheaSwapReviewView | null) => void
  setQuoteKey: (key: string | null) => void
  setQuoteReceivedAt: (time: number | null) => void
  setAmountOut: (amount: string) => void
  setDepositAddress: (address: string) => void
  setQuoteError: (message: string | null) => void
  setQuoteRetryable: (retryable: boolean) => void
  setIsQuoting: (quoting: boolean) => void
  setTransferPreparationError: (message: string | null) => void
}

export function useRheaSwapQuote({
  viewStep,
  scopeKey,
  request,
  purpose,
  fundingSource,
  refreshTick,
  currentQuote,
  currentKey,
  outputDecimals,
  immediate,
  walletId,
  accountId,
  sequence,
  lastRequestedKey,
  reviewRefreshTarget,
  autoReviewStartedScope,
  setQuote,
  setReview,
  setQuoteKey,
  setQuoteReceivedAt,
  setAmountOut,
  setDepositAddress,
  setQuoteError,
  setQuoteRetryable,
  setIsQuoting,
  setTransferPreparationError
}: RheaSwapQuoteOptions): void {
  const effectKey = JSON.stringify([scopeKey, purpose, request?.key ?? null])
  const lastRefreshTick = useRef(refreshTick)
  // Receiving a quote updates display state; only a new intent or refresh starts a request.
  const snapshot = useRef({ request, currentQuote, currentKey, immediate, walletId, accountId })
  snapshot.current = { request, currentQuote, currentKey, immediate, walletId, accountId }

  useEffect(() => {
    const refreshingReview = viewStep === 'review' && reviewRefreshTarget.current !== null
    if (viewStep !== 'input' && !refreshingReview) {
      setIsQuoting(false)
      return
    }

    const requestSequence = ++sequence.current
    const { request, currentQuote, currentKey, immediate, walletId, accountId } = snapshot.current
    const requestChanged = lastRequestedKey.current !== effectKey
    const refreshRequested = lastRefreshTick.current !== refreshTick
    lastRequestedKey.current = effectKey
    lastRefreshTick.current = refreshTick

    const clearOutput = () => {
      setQuoteKey(null)
      setQuoteReceivedAt(null)
      setAmountOut('')
      setDepositAddress('')
    }

    if (requestChanged) {
      const target = reviewRefreshTarget.current
      if (target && request && !isSwapQuoteRefreshReady(target, request, request.key)) {
        reviewRefreshTarget.current = null
        autoReviewStartedScope.current = null
      }
      if (!refreshingReview) {
        setQuote(null)
        setReview(null)
      }
      clearOutput()
    }
    setQuoteError(null)
    setQuoteRetryable(false)

    if (
      !request ||
      outputDecimals === undefined ||
      (!requestChanged &&
        !refreshRequested &&
        !refreshingReview &&
        currentKey === request.key &&
        currentQuote &&
        isRheaSwapQuoteFresh(currentQuote))
    ) {
      setIsQuoting(false)
      return
    }

    setIsQuoting(true)
    let disposed = false
    const isCurrent = () => !disposed && requestSequence === sequence.current
    const requestQuote = async () => {
      try {
        const quote = await rheaSwapClient.quote(request.request, purpose, fundingSource)
        if (!isCurrent()) {
          void rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
          return
        }
        setQuote(quote)
        setQuoteKey(request.key)
        setQuoteReceivedAt(quote.receivedAt)
        setAmountOut(formatBaseUnitDecimalAmount(quote.estimatedOut, outputDecimals))
        setDepositAddress('')
      } catch (error) {
        if (!isCurrent()) return
        const failure = getRheaSwapQuoteFailure(error)
        logger.warn('[Swap] Quote failed', walletId ?? undefined, accountId ?? undefined, error)
        reviewRefreshTarget.current = null
        if (refreshingReview) {
          setTransferPreparationError(failure.message)
        } else {
          setQuote(null)
        }
        clearOutput()
        setQuoteError(failure.message)
        setQuoteRetryable(failure.retryable)
      } finally {
        if (isCurrent()) setIsQuoting(false)
      }
    }
    const timer = window.setTimeout(() => void requestQuote(), immediate ? 0 : QUOTE_DEBOUNCE_MS)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [
    viewStep,
    refreshTick,
    effectKey,
    purpose,
    fundingSource,
    outputDecimals,
    sequence,
    lastRequestedKey,
    reviewRefreshTarget,
    autoReviewStartedScope,
    setQuote,
    setReview,
    setQuoteKey,
    setQuoteReceivedAt,
    setAmountOut,
    setDepositAddress,
    setQuoteError,
    setQuoteRetryable,
    setIsQuoting,
    setTransferPreparationError
  ])
}

export function useResumeRheaSwapReview({
  target,
  request,
  quoteKey,
  quote,
  isQuoting,
  onReview
}: {
  target: RefObject<SwapQuoteRefreshTarget | null>
  request: ReturnType<typeof buildLiveSwapQuoteRequest>
  quoteKey: string | null
  quote: RheaSwapQuoteView | null
  isQuoting: boolean
  onReview: () => Promise<void>
}): void {
  useEffect(() => {
    if (
      !isSwapQuoteRefreshReady(target.current, request, quoteKey) ||
      isQuoting ||
      !quote ||
      !request ||
      quoteKey !== request.key ||
      !isRheaSwapQuoteFresh(quote)
    ) {
      return
    }
    target.current = null
    void onReview()
  }, [target, request, quoteKey, quote, isQuoting, onReview])
}
