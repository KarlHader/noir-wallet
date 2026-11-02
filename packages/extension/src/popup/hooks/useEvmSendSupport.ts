import { useEffect, useState } from 'react'
import type { ChainDefinition } from '@/core/chains/registry'
import { resolveConfidentialEvmAssetSupport } from '@/core/services/rhea-swap/rhea-confidential-support'
import { evmSendCatalogRequest, loadEvmSendCatalog } from '@/popup/services/evm-send-catalog'
import { rheaSwapClient } from '@/popup/services/rhea-swap-client'

export function useEvmSendSupport(
  chain: ChainDefinition,
  asset: {
    readonly id: string
    readonly chainId: string
    readonly kind: string
    readonly reference: string
  },
  contextKey: string
) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; loading: boolean } | null>(null)
  const request = evmSendCatalogRequest(chain)
  const key = JSON.stringify([contextKey, asset.id, attempt])
  const cached = request ? rheaSwapClient.readCachedTokens(request) : null
  const support = resolveConfidentialEvmAssetSupport({ chain, asset, catalog: cached })
  useEffect(() => {
    if (!request || cached) return
    let cancelled = false
    setResult({ key, loading: true })
    void loadEvmSendCatalog(
      request,
      () => !cancelled,
      () => setResult({ key, loading: false })
    )
    return () => {
      cancelled = true
    }
  }, [key, chain.id, cached])
  return {
    support,
    loading:
      support === 'unknown' &&
      Boolean(request) &&
      !cached &&
      (result?.key !== key || result.loading),
    retry: () => {
      // Missing capability metadata may have been cached by another consumer.
      if (request) void rheaSwapClient.listTokens(request, { bypassCache: true }).catch(() => {})
      setAttempt(value => value + 1)
    }
  }
}
