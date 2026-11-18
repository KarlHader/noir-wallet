import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import {
  getPortfolioSnapshot,
  portfolioSnapshotKey,
  readPortfolioSnapshot,
  refreshPortfolioSnapshot,
  subscribePortfolioSnapshot
} from '@/popup/services/portfolio-snapshot-store'

export function usePortfolioSnapshot(
  walletId: string | null,
  accountId: string | null,
  options: { readonly enabled?: boolean; readonly autoRefresh?: boolean } = {}
) {
  const network = useWalletStore(state => state.currentNetwork)
  const endpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const enabled = options.enabled !== false && Boolean(walletId && accountId)
  const autoRefresh = options.autoRefresh !== false
  const scope =
    enabled && walletId && accountId ? { network, walletId, accountId, endpointRuntimeKey } : null
  const key = scope ? portfolioSnapshotKey(scope) : ''
  const subscribe = useCallback(
    (listener: () => void) => subscribePortfolioSnapshot(key, listener),
    [key]
  )
  const getSnapshot = useCallback(() => getPortfolioSnapshot(key, scope ?? undefined), [key])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const readLatest = useCallback(() => readPortfolioSnapshot(key), [key])
  const refresh = useCallback(
    (
      force = false,
      refreshOptions: {
        readonly chainIds?: readonly string[]
        readonly additionalChainIds?: readonly string[]
        readonly forceDiscovery?: boolean
      } = {}
    ) => refreshPortfolioSnapshot(key, force, refreshOptions),
    [key]
  )

  useEffect(() => {
    if (!key) return
    let active = true
    void readPortfolioSnapshot(key).then(() => {
      if (active && autoRefresh) return refreshPortfolioSnapshot(key)
    })
    return () => {
      active = false
    }
  }, [autoRefresh, key])

  return { ...snapshot, refresh, readLatest }
}
