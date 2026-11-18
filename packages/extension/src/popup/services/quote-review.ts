import type { RheaSwapQuoteView } from '@/core/services/rhea-swap'
import type {
  ConfidentialFundingPreview,
  ConfidentialFundingReview
} from '@/core/services/confidential-funding'
import type { NativeZecIntentsSwapReview } from '@/core/services/native-zec-intents-swap'

export interface QuoteTerms {
  readonly sourceAmount?: string
  readonly expected?: string
  readonly minimum?: string
  readonly route?: string
  readonly appFeeBps?: number
  readonly withdrawFee?: string
}

export function rheaQuoteTerms(quote: RheaSwapQuoteView): QuoteTerms {
  return { expected: quote.estimatedOut, minimum: quote.minAmountOut, route: quote.router }
}

export function confidentialQuoteTerms(
  quote: ConfidentialFundingPreview | ConfidentialFundingReview
): QuoteTerms {
  return 'planId' in quote
    ? {
        expected: quote.expectedOutputRaw,
        minimum: quote.minimumOutputRaw,
        appFeeBps: quote.quoteAppFeeBps,
        withdrawFee: quote.quoteWithdrawFeeRaw
      }
    : {
        expected: quote.amountOutRaw,
        minimum: quote.minimumOutputRaw,
        appFeeBps: quote.appFeeBps
      }
}

export function nativeZecQuoteTerms(quote: NativeZecIntentsSwapReview): QuoteTerms {
  return { expected: quote.expectedOutputRaw, minimum: quote.minimumOutputRaw }
}

export interface QuoteTermsChange {
  readonly field: keyof QuoteTerms
  readonly previous: string | number
  readonly current: string | number
}

const fields = ['sourceAmount', 'expected', 'minimum', 'route', 'appFeeBps', 'withdrawFee'] as const

export function compareQuoteTerms(previous: QuoteTerms, current: QuoteTerms): QuoteTermsChange[] {
  return fields.flatMap(field => {
    const before = previous[field]
    const after = current[field]
    return before !== undefined && after !== undefined && before !== after
      ? [{ field, previous: before, current: after }]
      : []
  })
}

export function quoteReviewActionLabel(changes: readonly QuoteTermsChange[]): string | undefined {
  if (!changes.length) return undefined
  return changes.every(change => change.field === 'route') ? 'Accept new route' : 'Accept new price'
}

export interface QuoteReviewCandidate {
  readonly id: string
  readonly terms: QuoteTerms
  readonly expiresAt: number
}

export interface QuoteReviewSession {
  readonly scope: string
  readonly baseline: QuoteTerms
  readonly candidate: QuoteReviewCandidate | null
}

export function stageQuoteReview(
  session: QuoteReviewSession | null,
  scope: string,
  candidate: QuoteReviewCandidate
): QuoteReviewSession | null {
  if (session?.scope !== scope) return null
  const unchanged = compareQuoteTerms(session.baseline, candidate.terms).length === 0
  return { ...session, baseline: unchanged ? candidate.terms : session.baseline, candidate }
}

export function canReviewQuote(
  session: QuoteReviewSession | null,
  scope: string | null,
  id: string | null,
  now = Date.now()
): session is QuoteReviewSession & { candidate: QuoteReviewCandidate } {
  return Boolean(
    session?.candidate &&
    session.scope === scope &&
    session.candidate.id === id &&
    session.candidate.expiresAt > now
  )
}

export function isQuoteReviewAccepted(
  session: QuoteReviewSession | null,
  scope: string | null,
  id: string | null,
  now = Date.now()
): boolean {
  return (
    canReviewQuote(session, scope, id, now) &&
    compareQuoteTerms(session.baseline, session.candidate.terms).length === 0
  )
}
