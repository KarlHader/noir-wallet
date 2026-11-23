import { useEffect, useState } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'

const EMPTY_CATALOG: readonly SwapToken[] = []

export function useShieldReceiveCatalog(enabled: boolean) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    attempt: number
    tokens: readonly SwapToken[] | null
  } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void swapTokenCatalogClient.refresh().then(
      tokens => {
        if (active) setResult({ attempt, tokens })
      },
      () => {
        if (active) setResult({ attempt, tokens: null })
      }
    )
    return () => {
      active = false
    }
  }, [attempt, enabled])

  const current = enabled && result?.attempt === attempt ? result : null
  return {
    tokens: current?.tokens ?? EMPTY_CATALOG,
    loading: enabled && !current,
    error: current?.tokens === null,
    retry: () => setAttempt(previous => previous + 1)
  }
}
