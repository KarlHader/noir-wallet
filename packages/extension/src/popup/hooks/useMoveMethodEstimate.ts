import { useEffect, useRef, useState } from 'react'
import type { MoveMethodEstimate } from '@/popup/services/move-method-estimate'

export function useMoveMethodEstimate({
  enabled,
  requestKey,
  estimate
}: {
  readonly enabled: boolean
  readonly requestKey: string
  readonly estimate: (signal: AbortSignal) => Promise<MoveMethodEstimate>
}): {
  value: MoveMethodEstimate | null
  loading: boolean
  error: boolean
  errorMessage: string | null
} {
  const estimateRef = useRef(estimate)
  estimateRef.current = estimate
  const [state, setState] = useState<{
    key: string
    value: MoveMethodEstimate | null
    loading: boolean
    error: boolean
    errorMessage: string | null
  }>({ key: '', value: null, loading: false, error: false, errorMessage: null })
  useEffect(() => {
    const controller = new AbortController()
    setState(previous =>
      previous.key === requestKey
        ? { ...previous, loading: enabled, error: false, errorMessage: null }
        : { key: requestKey, value: null, loading: enabled, error: false, errorMessage: null }
    )
    if (!enabled) return () => controller.abort()
    // These are indicative fees, not execution quotes. Review obtains a fresh
    // quote; polling here repeatedly prepares routes while the user is idle.
    const timer = setTimeout(async () => {
      try {
        const value = await estimateRef.current(controller.signal)
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
    return { value: null, loading: false, error: false, errorMessage: null }
  }
  return {
    value: state.value,
    loading: state.loading,
    error: state.error,
    errorMessage: state.errorMessage
  }
}
