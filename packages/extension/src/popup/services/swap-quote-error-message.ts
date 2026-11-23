import { getRheaSwapMinimumAmountMessage } from '@/core/services/rhea-swap/rhea-swap-error'

export const SWAP_QUOTE_DISPLAY_ERROR = 'no route'
const UNSUPPORTED_SWAP_DESTINATION =
  'This destination is unavailable for this swap. Choose another asset.'

export function getSwapQuoteNotice(message: string | null | undefined): string | null {
  if (!message) return null
  if (message === SWAP_QUOTE_DISPLAY_ERROR) return 'No route'
  if (message === 'Quote expired. Try again.' || message === 'Shield quote expired. Try again.') {
    return 'Quote expired.'
  }
  if (message === UNSUPPORTED_SWAP_DESTINATION) return message
  return getRheaSwapMinimumAmountMessage(message)
}

export function isSwapQuoteTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  return message !== null && hasSwapTimeoutReason(message)
}

export function readSwapErrorReason(message: string, depth = 0): string {
  if (depth >= 4) return ''
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start !== -1) {
    try {
      const payload: unknown = JSON.parse(message.slice(start, end + 1))
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>
        for (const key of ['message', 'msg', 'reason', 'error']) {
          if (typeof record[key] === 'string') return readSwapErrorReason(record[key], depth + 1)
        }
      }
    } catch {
      // An invalid upstream response must not become product copy.
    }
    return ''
  }
  return message.trim().replace(/^HTTP \d{3}:\s*/i, '')
}

export function isSwapQuotePriceMoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  return (
    message !== null &&
    /^Price moved too much,\s*please re-quote\.?$/i.test(readSwapErrorReason(message))
  )
}

function hasSwapTimeoutReason(value: unknown, depth = 0): boolean {
  if (depth >= 6) return false
  if (typeof value === 'string') {
    const start = value.indexOf('{')
    const reason = start === -1 ? value : value.slice(0, start)
    if (
      /\b(?:quote_timeout|request timed? out|transport (?:timed? out|timeout)|quote (?:timed? out|timeout)|deadline exceeded)\b/i.test(
        reason
      )
    ) {
      return true
    }
    if (start === -1) return false
    try {
      return hasSwapTimeoutReason(
        JSON.parse(value.slice(start, value.lastIndexOf('}') + 1)),
        depth + 1
      )
    } catch {
      return false
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return ['message', 'msg', 'reason', 'error', 'code', 'errorCode', 'apiCode'].some(key =>
    hasSwapTimeoutReason(record[key], depth + 1)
  )
}

export function getSwapQuoteFailureMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (message === null) return null
  const minimum = getRheaSwapMinimumAmountMessage(message)
  if (minimum) return minimum
  const reason = readSwapErrorReason(message)
  if (isSwapQuotePriceMoved(error)) {
    return reason
  }
  if (/unsupported destination token|destinationtoken.*not supported/i.test(reason)) {
    return UNSUPPORTED_SWAP_DESTINATION
  }
  if (/\b(?:crossChainTimeoutMs|sameChainTimeoutMs|quoteWaitingTimeMs)\b/i.test(reason)) {
    return 'Quote unavailable. Please try again.'
  }
  if (hasSwapTimeoutReason(message)) return 'Request timed out.'
  if (
    /\b(?:confidential_route_unavailable|route_unavailable|route_not_found|no_route|no (?:confidential |supported |swap )?route|route not found|no liquidity|quote response does not contain a valid best route)\b/i.test(
      reason
    )
  ) {
    return SWAP_QUOTE_DISPLAY_ERROR
  }
  return null
}
