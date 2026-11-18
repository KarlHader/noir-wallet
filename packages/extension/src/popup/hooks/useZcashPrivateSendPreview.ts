import { useEffect, useRef, useState } from 'react'
import type { FeeTier } from '@/config/fee'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { safeBig } from '@/lib/big'
import { isPublicPrivateSendRecipient } from '@/popup/services/evm-send-validation'
import { buildZcashPublicPrivateSendPreviewRequest } from '@/popup/services/public-private-send-preview'
import { rheaSwapClient, getRheaSwapErrorMessage } from '@/popup/services/rhea-swap-client'
import { isRheaSwapQuoteFresh, getRheaSwapQuoteDeadline } from '@/popup/services/swap-page-model'
import type { RheaSwapQuoteView } from '@/core/services/rhea-swap'

export function useZcashPrivateSendPreview({
  enabled,
  scopeKey,
  sender,
  recipient,
  amount,
  available,
  feeTier
}: {
  readonly enabled: boolean
  readonly scopeKey: string
  readonly sender: string
  readonly recipient: string
  readonly amount: string
  readonly available: string
  readonly feeTier: FeeTier
}) {
  const [preview, setPreview] = useState<{
    key: string
    quote: RheaSwapQuoteView
    amountRaw: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const key =
    enabled &&
    sender &&
    isPublicPrivateSendRecipient(ZEC_ZCASH_ASSET, recipient) &&
    safeBig(amount || '0').gt(0) &&
    safeBig(amount || '0').lte(available)
      ? JSON.stringify([scopeKey, sender, recipient, amount, feeTier])
      : null
  const currentKey = useRef(key)
  currentKey.current = key
  const ready = Boolean(key && preview?.key === key && isRheaSwapQuoteFresh(preview.quote))

  useEffect(() => {
    setPreview(null)
    setError(null)
    if (!key) return
    let cancelled = false
    let quoteHandle: string | null = null
    let expiryTimer: number | undefined
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [source, destination] = await Promise.all([
            rheaSwapClient.listTokens({ direction: 'from', tokenListChainIds: [900010] }),
            rheaSwapClient.listTokens({ direction: 'cross-chain-to', tokenListChainIds: [900010] })
          ])
          if (cancelled) return
          const request = buildZcashPublicPrivateSendPreviewRequest({
            sourceTokens: source.tokens,
            destinationTokens: destination.tokens,
            amount,
            slippage: 1,
            sender,
            recipient
          })
          if (!request) throw new Error('Confidential route unavailable')
          const quote = await rheaSwapClient.quote(request.request, 'public-private-send')
          if (cancelled || currentKey.current !== key) {
            void rheaSwapClient.discard(quote.quoteHandle).catch(() => {})
            return
          }
          quoteHandle = quote.quoteHandle
          if (!isRheaSwapQuoteFresh(quote) || quote.recipient !== recipient)
            throw new Error('Quote expired. Try again.')
          setPreview({ key, quote, amountRaw: request.amount })
          expiryTimer = window.setTimeout(
            () => {
              if (cancelled || currentKey.current !== key) return
              setPreview(null)
              setError('Quote expired. Try again.')
              if (quoteHandle) void rheaSwapClient.discard(quoteHandle).catch(() => {})
              quoteHandle = null
            },
            Math.max(0, getRheaSwapQuoteDeadline(quote) - Date.now())
          )
        } catch (cause) {
          if (quoteHandle) {
            void rheaSwapClient.discard(quoteHandle).catch(() => {})
            quoteHandle = null
          }
          if (!cancelled && currentKey.current === key) setError(getRheaSwapErrorMessage(cause))
        }
      })()
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      if (quoteHandle) void rheaSwapClient.discard(quoteHandle).catch(() => {})
    }
  }, [key, retryCount])

  return { preview, error, ready, key, retry: () => setRetryCount(value => value + 1) }
}
