export const RHEA_SWAP_MAX_QUOTE_AGE_MS = 5 * 60_000

export function assertRheaSwapSubmissionDeadline(
  deadline: number | undefined,
  now = Date.now()
): void {
  if (deadline === undefined) return
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || now < 0 || now >= deadline) {
    throw new Error('RHEA Swap quote expired. Get a new quote and review it again.')
  }
}

export function getRheaSwapQuoteDeadline(quote: {
  readonly receivedAt: number
  readonly expiresAt: number | null
}): number {
  if (
    !Number.isSafeInteger(quote.receivedAt) ||
    quote.receivedAt < 0 ||
    (quote.expiresAt !== null &&
      (!Number.isSafeInteger(quote.expiresAt) || quote.expiresAt < quote.receivedAt))
  ) {
    throw new Error('Invalid RHEA Swap quote validity')
  }
  const ageDeadline = quote.receivedAt + RHEA_SWAP_MAX_QUOTE_AGE_MS
  return quote.expiresAt === null ? ageDeadline : Math.min(ageDeadline, quote.expiresAt)
}

export function isRheaSwapQuoteFresh(
  quote: { readonly receivedAt: number; readonly expiresAt: number | null },
  now = Date.now()
): boolean {
  if (!Number.isSafeInteger(now) || now < quote.receivedAt) return false
  try {
    return now < getRheaSwapQuoteDeadline(quote)
  } catch {
    return false
  }
}
