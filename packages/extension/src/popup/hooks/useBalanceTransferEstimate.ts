import { useEffect, useRef, useState } from 'react'

export function useBalanceTransferEstimate<T>({
  enabled,
  requestKey,
  estimate
}: {
  readonly enabled: boolean
  readonly requestKey: string
  readonly estimate: (signal: AbortSignal) => Promise<T>
}): {
  value: T | null
  loading: boolean
  error: boolean
  errorMessage: string | null
} {
  const estimateRef = useRef(estimate)
  estimateRef.current = estimate
  const [state, setState] = useState<{
    key: string
    value: T | null
    loading: boolean
    error: boolean
    errorMessage: string | null
  }>({ key: '', value: null, loading: false, error: false, errorMessage: null })
  useEffect(() => {
    const controller = new AbortController()
    const estimateRequest = estimateRef.current
    setState(previous =>
      previous.key === requestKey
        ? { ...previous, loading: enabled, error: false, errorMessage: null }
        : { key: requestKey, value: null, loading: enabled, error: false, errorMessage: null }
    )
    if (!enabled) return () => controller.abort()
    // Debounce input changes without polling for new quotes while the user is idle.
    const timer = setTimeout(async () => {
      try {
        const value = await estimateRequest(controller.signal)
        if (!controller.signal.aborted)
          setState({
            key: requestKey,
            value,
            loading: false,
            error: false,
            errorMessage: null
          })
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : null
          setState(previous =>
            previous.key === requestKey
              ? {
                  ...previous,
                  loading: false,
                  error: true,
                  errorMessage: message
                }
              : {
                  key: requestKey,
                  value: null,
                  loading: false,
                  error: true,
                  errorMessage: message
                }
          )
        }
      }
    }, 450)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [enabled, requestKey])
  if (!enabled || state.key !== requestKey) {
    return { value: null, loading: enabled, error: false, errorMessage: null }
  }
  return {
    value: state.value,
    loading: state.loading,
    error: state.error,
    errorMessage: state.errorMessage
  }
}
