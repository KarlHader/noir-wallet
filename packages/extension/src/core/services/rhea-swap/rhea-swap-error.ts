const MINIMUM_SWAP_AMOUNT_PATTERN =
  /minimum (?:swap )?amount(?:\s+is|\s+of|:)?\s*(\$(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,4})(?:\.\d{1,6})?)(?![\w,]|\.[\w,.])/i

export function getRheaSwapMinimumAmountMessage(message: string): string | null {
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
