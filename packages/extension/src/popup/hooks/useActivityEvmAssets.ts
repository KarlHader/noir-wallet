import { useEffect, useState } from 'react'
import type { DetectedEvmAssetRecord, UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { userEvmAssetsClient } from '@/popup/services/user-evm-assets-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'

const EMPTY_ACTIVITY_EVM_ASSETS = Object.freeze({
  userAssets: Object.freeze([]) as readonly UserEvmAssetRecord[],
  detectedAssets: Object.freeze([]) as readonly DetectedEvmAssetRecord[],
  catalogTokens: Object.freeze([]) as readonly SwapToken[]
})

export function useActivityEvmAssets(): Readonly<{
  userAssets: readonly UserEvmAssetRecord[]
  detectedAssets: readonly DetectedEvmAssetRecord[]
  catalogTokens: readonly SwapToken[]
}> {
  const [assets, setAssets] = useState(EMPTY_ACTIVITY_EVM_ASSETS)

  useEffect(() => {
    let cancelled = false
    void userEvmAssetsClient
      .listManaged()
      .then(result => {
        if (!cancelled)
          setAssets(current => ({
            ...current,
            userAssets: result.userAssets,
            detectedAssets: result.detectedAssets
          }))
      })
      .catch(async () => {
        const userAssets = await userEvmAssetsClient.list().catch(() => [])
        if (!cancelled) setAssets(current => ({ ...current, userAssets, detectedAssets: [] }))
      })
    void swapTokenCatalogClient
      .readCached()
      .then(async cached => (cached.length > 0 ? cached : swapTokenCatalogClient.refresh()))
      .then(catalogTokens => {
        if (!cancelled) setAssets(current => ({ ...current, catalogTokens }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return assets
}
