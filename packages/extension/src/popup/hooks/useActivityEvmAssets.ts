import { useEffect, useState } from 'react'
import type { DetectedEvmAssetRecord, UserEvmAssetRecord } from '@/core/chains/user-assets'
import { userEvmAssetsClient } from '@/popup/services/user-evm-assets-client'

const EMPTY_ACTIVITY_EVM_ASSETS = Object.freeze({
  userAssets: Object.freeze([]) as readonly UserEvmAssetRecord[],
  detectedAssets: Object.freeze([]) as readonly DetectedEvmAssetRecord[]
})

export function useActivityEvmAssets(): Readonly<{
  userAssets: readonly UserEvmAssetRecord[]
  detectedAssets: readonly DetectedEvmAssetRecord[]
}> {
  const [assets, setAssets] = useState(EMPTY_ACTIVITY_EVM_ASSETS)

  useEffect(() => {
    let cancelled = false
    void userEvmAssetsClient
      .listManaged()
      .then(result => {
        if (!cancelled)
          setAssets({ userAssets: result.userAssets, detectedAssets: result.detectedAssets })
      })
      .catch(async () => {
        const userAssets = await userEvmAssetsClient.list().catch(() => [])
        if (!cancelled) setAssets({ userAssets, detectedAssets: [] })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return assets
}
