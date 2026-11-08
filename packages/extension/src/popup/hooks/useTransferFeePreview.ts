import { useEffect, useRef, useState } from 'react'

interface TransferFeePreviewOptions {
  readonly enabled: boolean
  readonly requestKey: string
  readonly estimate: () => Promise<string>
  readonly delayMs?: number
}

interface TransferFeePreview {
  readonly amountRaw: string | null
  readonly loading: boolean
}

export function useTransferFeePreview({
  enabled,
  requestKey,
  estimate,
  delayMs = 450
}: TransferFeePreviewOptions): TransferFeePreview {
  const estimateRef = useRef(estimate)
  const [state, setState] = useState<{
    key: string
    amountRaw: string | null
    loading: boolean
  }>({ key: '', amountRaw: null, loading: false })

  useEffect(() => {
    estimateRef.current = estimate
  }, [estimate])

  useEffect(() => {
    let active = true
    setState({ key: requestKey, amountRaw: null, loading: false })
    if (!enabled) return () => undefined
    setState({ key: requestKey, amountRaw: null, loading: true })

    const timer = window.setTimeout(() => {
      if (!active) return
      void estimateRef
        .current()
        .then(value => {
          if (active) setState(current => ({ ...current, amountRaw: value }))
        })
        .catch(() => {
          if (active) setState(current => ({ ...current, amountRaw: null }))
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
    ? { amountRaw: state.amountRaw, loading: state.loading }
    : { amountRaw: null, loading: false }
}
