import { useEffect, useState } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'

export function useSwapTokenCatalog(enabled = true): readonly SwapToken[] | null {
  const [tokens, setTokens] = useState<readonly SwapToken[] | null>(null)

  useEffect(() => {
    if (!enabled) return
    let active = true
    let refreshed = false
    void swapTokenCatalogClient
      .readCached()
      .then(cached => {
        if (active && !refreshed && cached.length > 0) setTokens(cached)
      })
      .catch(() => {})
    void swapTokenCatalogClient
      .refresh()
      .then(current => {
        refreshed = true
        if (active) setTokens(current)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [enabled])

  return tokens
}
