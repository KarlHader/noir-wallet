import { useEffect, useRef, useState } from 'react'

interface TransferFeeEstimate<T> {
  readonly amountRaw: string
  readonly details: T
}

interface TransferFeePreviewOptions<T> {
  readonly enabled: boolean
  readonly requestKey: string
  readonly estimate: () => Promise<string | TransferFeeEstimate<T>>
  readonly delayMs?: number
}

interface TransferFeePreview<T> {
  readonly amountRaw: string | null
  readonly details: T | null
  readonly loading: boolean
}

export function useTransferFeePreview<T = never>({
  enabled,
  requestKey,
  estimate,
  delayMs = 450
}: TransferFeePreviewOptions<T>): TransferFeePreview<T> {
  const estimateRef = useRef(estimate)
  const [state, setState] = useState<{
    key: string
    amountRaw: string | null
    details: T | null
    loading: boolean
  }>({ key: '', amountRaw: null, details: null, loading: false })

  useEffect(() => {
    estimateRef.current = estimate
  }, [estimate])

  useEffect(() => {
    let active = true
    setState({ key: requestKey, amountRaw: null, details: null, loading: false })
    if (!enabled) return () => undefined
    setState({ key: requestKey, amountRaw: null, details: null, loading: true })

    const timer = window.setTimeout(() => {
      if (!active) return
      void estimateRef
        .current()
        .then(value => {
          if (active)
            setState(current => ({
              ...current,
              amountRaw: typeof value === 'string' ? value : value.amountRaw,
              details: typeof value === 'string' ? null : value.details
            }))
        })
        .catch(() => {
          if (active) setState(current => ({ ...current, amountRaw: null, details: null }))
        })
        .finally(() => {
          if (active) setState(current => ({ ...current, loading: false }))
        })
    }, delayMs)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [delayMs, enabled, requestKey])

  return state.key === requestKey && enabled
    ? { amountRaw: state.amountRaw, details: state.details, loading: state.loading }
    : { amountRaw: null, details: null, loading: false }
}
