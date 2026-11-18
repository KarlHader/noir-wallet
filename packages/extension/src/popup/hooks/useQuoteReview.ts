import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canReviewQuote,
  compareQuoteTerms,
  isQuoteReviewAccepted,
  quoteReviewActionLabel,
  stageQuoteReview,
  type QuoteReviewCandidate,
  type QuoteReviewSession,
  type QuoteTerms
} from '@/popup/services/quote-review'

// One-shot, popup-local handoff; execution is still prepared and bound by the destination page.
let handoff: {
  readonly path: string
  readonly terms: QuoteTerms
  readonly expiresAt: number
} | null = null

export function carryQuotePreview(path: string, terms: QuoteTerms): string {
  handoff = { path, terms, expiresAt: Date.now() + 60_000 }
  return path
}

export function takeQuotePreview(path: string): QuoteTerms | undefined {
  if (handoff?.path !== path) return undefined
  const value = handoff
  handoff = null
  return value.expiresAt > Date.now() ? value.terms : undefined
}

export function useQuoteReview() {
  const [session, setSession] = useState<QuoteReviewSession | null>(null)
  const current = useRef<QuoteReviewSession | null>(null)

  const update = useCallback((value: QuoteReviewSession | null) => {
    current.current = value
    setSession(value)
  }, [])

  const begin = useCallback(
    (scope: string, baseline: QuoteTerms) => {
      if (current.current?.scope !== scope) update({ scope, baseline, candidate: null })
    },
    [update]
  )

  const stage = useCallback(
    (scope: string, candidate: QuoteReviewCandidate) => {
      const next = stageQuoteReview(current.current, scope, candidate)
      if (!next) return false
      update(next)
      return true
    },
    [update]
  )

  const reset = useCallback(() => update(null), [update])

  const accept = useCallback(
    (scope: string | null, id: string | null) => {
      const value = current.current
      if (!canReviewQuote(value, scope, id)) return false
      update({ ...value, baseline: value.candidate.terms })
      return true
    },
    [update]
  )

  const isAccepted = useCallback((scope: string | null, id: string | null) => {
    return isQuoteReviewAccepted(current.current, scope, id)
  }, [])

  const describe = (scope: string | null, id: string | null) => {
    const candidate =
      session?.scope === scope && session.candidate?.id === id ? session.candidate : null
    const changes = candidate && session ? compareQuoteTerms(session.baseline, candidate.terms) : []
    return { changes, acceptLabel: quoteReviewActionLabel(changes) }
  }

  return { begin, stage, reset, accept, isAccepted, describe }
}

export function useQuoteReviewTimer({
  expiresAt,
  active,
  refresh,
  autoRefreshMs
}: {
  readonly expiresAt: number | null
  readonly active: boolean
  readonly refresh?: () => void
  readonly autoRefreshMs?: number
}): boolean {
  const [, rerender] = useState(0)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const canRefresh = refresh !== undefined
  useEffect(() => {
    if (!active || expiresAt === null) return
    const deadlineTimer = window.setTimeout(
      () => rerender(value => value + 1),
      Math.max(0, expiresAt - Date.now())
    )
    const refreshTimer =
      canRefresh && autoRefreshMs !== undefined
        ? window.setTimeout(
            () => refreshRef.current?.(),
            Math.max(0, Math.min(autoRefreshMs, expiresAt - Date.now() - 5_000))
          )
        : undefined
    return () => {
      window.clearTimeout(deadlineTimer)
      window.clearTimeout(refreshTimer)
    }
  }, [active, expiresAt, canRefresh, autoRefreshMs])
  return expiresAt !== null && expiresAt <= Date.now()
}
