import { useEffect, useMemo, useState } from 'react'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { useSettingsStore } from '@/store/settings-store'
import {
  getLendingMarket,
  loadLendingApr,
  readCachedLendingApr
} from '@/popup/services/lending-market-rates'

export function useLendingMarketRate(eligibleAssetId: string | undefined) {
  const market = eligibleAssetId ? getLendingMarket(eligibleAssetId) : undefined
  const settings = useSettingsStore(state => state.chainEndpointSettings)
  const network = useMemo(() => resolveNearRuntimeNetworkConfig('mainnet', settings), [settings])
  const [settled, setSettled] = useState<{
    tokenId: string
    rpcUrl: string
    apr: string | null
  }>()

  useEffect(() => {
    if (!market) return
    let active = true
    const settle = (apr: string | null) => {
      if (active) setSettled({ tokenId: market.tokenId, rpcUrl: network.rpcUrl, apr })
    }
    void loadLendingApr(market, network).then(settle, () => settle(null))
    return () => {
      active = false
    }
  }, [market, network])

  if (!market) return null
  const cached = readCachedLendingApr(market, network.rpcUrl)
  const apr =
    cached ??
    (settled?.tokenId === market.tokenId && settled.rpcUrl === network.rpcUrl
      ? settled.apr
      : undefined)
  return { url: market.url, apr }
}
