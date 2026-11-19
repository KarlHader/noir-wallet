const MINIMUM_SWAP_AMOUNT_PATTERN =
  /minimum (?:swap )?amount(?:\s+is|\s+of|:)?\s*(\$(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,4})(?:\.\d{1,6})?)(?![\w,]|\.[\w,.])/i
const BRIDGE_MINIMUM_MESSAGE =
  'Amount is below the route minimum. Increase the amount and try again.'

export type RheaSwapErrorStage = 'quote' | 'build' | 'submit' | 'report' | 'status' | 'tokens'
export type RheaSwapErrorCode =
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'ROUTE_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTE_EXPIRED'
  | 'HTTP_ERROR'
  | 'API_ERROR'
  | 'INVALID_API_RESPONSE'
  | 'INVALID_REQUEST'

export class RheaSwapHttpError extends Error {
  readonly name = 'RheaSwapHttpError'

  constructor(
    readonly code: RheaSwapErrorCode,
    readonly stage: RheaSwapErrorStage,
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

export function getRheaSwapMinimumAmountMessage(message: string): string | null {
  if (message === BRIDGE_MINIMUM_MESSAGE || /\bamount is too low for bridge\b/i.test(message)) {
    return BRIDGE_MINIMUM_MESSAGE
  }
  const minimum = message.match(MINIMUM_SWAP_AMOUNT_PATTERN)?.[1]
  return minimum ? `Minimum swap amount is ${minimum}.` : null
}

export function getSafeRheaSwapRuntimeErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message.trim() : ''
  const minimum = getRheaSwapMinimumAmountMessage(rawMessage)
  if (minimum) return minimum
  if (
    rawMessage &&
    rawMessage.length <= 500 &&
    !/(?:bearer|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|mnemonic|signature)\s*[:=]/i.test(
      rawMessage
    )
  ) {
    return rawMessage.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
  }
  return 'RHEA Swap request failed'
}
