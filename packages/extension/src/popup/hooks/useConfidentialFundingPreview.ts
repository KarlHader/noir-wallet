import { useEffect, useRef, useState } from 'react'
import type { ConfidentialFundingPreview } from '@/core/services/confidential-funding'
import {
  confidentialFundingClient,
  type PrepareConfidentialFundingRequest
} from '@/popup/services/confidential-funding-client'
import { getSwapQuoteFailureMessage } from '@/popup/services/swap-quote-error-message'

const PREVIEW_DEBOUNCE_MS = 350
const PREVIEW_EXPIRY_BUFFER_MS = 5_000

type PreviewState = Readonly<{
  key: string | null
  value: ConfidentialFundingPreview | null
  error: string | null
  loading: boolean
}>

export function useConfidentialFundingPreview(
  request: PrepareConfidentialFundingRequest | null,
  scopeKey: string
) {
  const [state, setState] = useState<PreviewState>({
    key: null,
    value: null,
    error: null,
    loading: false
  })
  const [revision, setRevision] = useState(0)
  const inFlight = useRef(new Map<string, Promise<ConfidentialFundingPreview>>())
  const requestRef = useRef(request)
  requestRef.current = request
  const key = request ? `${scopeKey}:${JSON.stringify(request)}` : null

  useEffect(() => {
    const currentRequest = requestRef.current
    if (!currentRequest || !key) {
      setState({ key: null, value: null, error: null, loading: false })
      return
    }
    let active = true
    let expiryTimer: number | undefined
    setState({ key, value: null, error: null, loading: true })
    const debounceTimer = window.setTimeout(() => {
      let pending = inFlight.current.get(key)
      if (!pending) {
        pending = confidentialFundingClient.preview(currentRequest)
        inFlight.current.set(key, pending)
        void pending
          .finally(() => {
            if (inFlight.current.get(key) === pending) inFlight.current.delete(key)
          })
          .catch(() => {})
      }
      void pending
        .then(value => {
          if (!active) return
          const remaining = value.expiresAt - Date.now() - PREVIEW_EXPIRY_BUFFER_MS
          if (remaining <= 0) throw new Error('Shield quote expired. Try again.')
          setState({ key, value, error: null, loading: false })
          expiryTimer = window.setTimeout(() => {
            if (active)
              setState({
                key,
                value: null,
                error: 'Shield quote expired. Try again.',
                loading: false
              })
          }, remaining)
        })
        .catch(error => {
          if (active)
            setState({
              key,
              value: null,
              error:
                getSwapQuoteFailureMessage(error) ??
                (error instanceof Error ? error.message : 'Shield quote unavailable'),
              loading: false
            })
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      active = false
      window.clearTimeout(debounceTimer)
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
    }
  }, [key, revision])

  return {
    preview:
      state.key === key &&
      state.value &&
      state.value.expiresAt > Date.now() + PREVIEW_EXPIRY_BUFFER_MS
        ? state.value
        : null,
    loading: Boolean(key) && (state.key !== key || state.loading),
    error: state.key === key ? state.error : null,
    retry: () => setRevision(value => value + 1)
  }
}
