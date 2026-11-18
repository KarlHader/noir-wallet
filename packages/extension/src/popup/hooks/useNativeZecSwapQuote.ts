import { useEffect, useRef, useState, type RefObject } from 'react'
import { classifyError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import {
  cancelNativeZecIntentsSwap,
  prepareNativeZecIntentsSwap,
  type NativeZecIntentsSwapReview,
  type PrepareNativeZecIntentsSwapInput
} from '@/popup/services/native-zec-intents-swap-client'
import {
  getSwapQuoteFailureMessage,
  isSwapQuoteTimeout,
  SWAP_QUOTE_DISPLAY_ERROR
} from '@/popup/services/swap-quote-error-message'

const QUOTE_DEBOUNCE_MS = 800
const QUOTE_EXPIRY_BUFFER_MS = 5_000

export function useNativeZecSwapQuote({
  active,
  request,
  outputDecimals,
  effectiveWalletId,
  effectiveAccountId,
  quoteRequestSequence,
  setAmountOut,
  setDepositAddress,
  setQuoteError,
  setIsQuoting,
  setQuoteRetryable,
  isSending,
  onExpire
}: {
  readonly active: boolean
  readonly request: {
    readonly key: string
    readonly input: PrepareNativeZecIntentsSwapInput
  } | null
  readonly outputDecimals: number | undefined
  readonly effectiveWalletId: string | null
  readonly effectiveAccountId: string | null
  readonly quoteRequestSequence: RefObject<number>
  readonly setAmountOut: (amount: string) => void
  readonly setDepositAddress: (address: string) => void
  readonly setQuoteError: (message: string | null) => void
  readonly setIsQuoting: (quoting: boolean) => void
  readonly setQuoteRetryable: (retryable: boolean) => void
  readonly isSending: boolean
  readonly onExpire: () => void
}) {
  const [nativeIntentsQuote, setNativeIntentsQuote] = useState<{
    readonly key: string
    readonly review: NativeZecIntentsSwapReview
  } | null>(null)
  const requestKey = request?.key ?? null
  const requestRef = useRef(request)
  const submittingQuoteId = useRef<string | null>(null)
  requestRef.current = request
  useEffect(() => {
    if (!active) {
      setNativeIntentsQuote(null)
      return
    }
    const sequence = ++quoteRequestSequence.current
    const request = requestRef.current
    setNativeIntentsQuote(null)
    setAmountOut('')
    setDepositAddress('')
    setQuoteError(null)
    setQuoteRetryable(false)
    if (!request) {
      setIsQuoting(false)
      return
    }
    setIsQuoting(true)
    let disposed = false
    let preparedQuoteId: string | null = null
    const timer = window.setTimeout(() => {
      void prepareNativeZecIntentsSwap(request.input)
        .then(review => {
          preparedQuoteId = review.quoteId
          if (disposed || sequence !== quoteRequestSequence.current) {
            void cancelNativeZecIntentsSwap(review.quoteId).catch(() => {})
            return
          }
          if (
            outputDecimals === undefined ||
            review.destination.assetId !== request.input.destination.assetId ||
            review.destination.protocolAssetId !== request.input.destination.protocolAssetId ||
            review.quoteBinding.recipientType !== request.input.recipientType ||
            review.quoteBinding.fundingSource !== request.input.fundingSource
          ) {
            void cancelNativeZecIntentsSwap(review.quoteId).catch(() => {})
            setQuoteError('Swap quote changed. Try again.')
            setQuoteRetryable(true)
            return
          }
          setNativeIntentsQuote({ key: request.key, review })
          setAmountOut(formatBaseUnitDecimalAmount(review.expectedOutputRaw, outputDecimals))
          setDepositAddress(review.depositAddress)
        })
        .catch(error => {
          if (disposed || sequence !== quoteRequestSequence.current) return
          const projected = getSwapQuoteFailureMessage(error)
          setQuoteError(
            isSwapQuoteTimeout(error) || projected === SWAP_QUOTE_DISPLAY_ERROR
              ? SWAP_QUOTE_DISPLAY_ERROR
              : (projected ?? classifyError(error).userMessage)
          )
          setQuoteRetryable(true)
          logger.warn(
            '[Swap] Intents quote failed',
            effectiveWalletId ?? undefined,
            effectiveAccountId ?? undefined,
            error
          )
        })
        .finally(() => {
          if (!disposed && sequence === quoteRequestSequence.current) setIsQuoting(false)
        })
    }, QUOTE_DEBOUNCE_MS)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      if (preparedQuoteId && submittingQuoteId.current !== preparedQuoteId)
        void cancelNativeZecIntentsSwap(preparedQuoteId).catch(() => {})
    }
  }, [
    active,
    requestKey,
    outputDecimals,
    quoteRequestSequence,
    setQuoteRetryable,
    setAmountOut,
    setDepositAddress,
    setQuoteError,
    setIsQuoting,
    effectiveWalletId,
    effectiveAccountId
  ])
  const nativeIntentsQuoteReady = Boolean(
    requestKey &&
    nativeIntentsQuote?.key === requestKey &&
    nativeIntentsQuote.review.expiresAt > Date.now() + QUOTE_EXPIRY_BUFFER_MS
  )
  useEffect(() => {
    if (!active || !nativeIntentsQuote || nativeIntentsQuote.key !== requestKey || isSending) return
    const remaining = nativeIntentsQuote.review.expiresAt - Date.now() - QUOTE_EXPIRY_BUFFER_MS
    const timer = window.setTimeout(onExpire, Math.max(0, remaining))
    return () => window.clearTimeout(timer)
  }, [active, nativeIntentsQuote, requestKey, isSending, onExpire])

  return {
    quote: nativeIntentsQuote,
    ready: nativeIntentsQuoteReady,
    requestKey,
    requestRef,
    submittingQuoteId
  }
}
