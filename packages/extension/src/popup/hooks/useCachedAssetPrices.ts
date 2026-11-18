import { useEffect, useState } from 'react'
import type { AssetPriceReadModel } from '@/core/prices'
import type { Network } from '@/types'
import { assetPriceClient } from '@/popup/services/asset-price-client'

export function useCachedAssetPrices(network: Network, enabled = true) {
  const [snapshot, setSnapshot] = useState<{
    network: Network
    prices: AssetPriceReadModel | null
  }>()

  useEffect(() => {
    if (!enabled) return
    let revision = 0
    const read = () => {
      const request = ++revision
      void assetPriceClient
        .getPrices('read')
        .then(prices => {
          if (request === revision) setSnapshot({ network, prices })
        })
        .catch(() => {})
    }
    const unsubscribe = assetPriceClient.onCacheChanged(read)
    read()
    return () => {
      revision++
      unsubscribe()
    }
  }, [enabled, network])

  return enabled && snapshot?.network === network ? snapshot.prices : null
}
