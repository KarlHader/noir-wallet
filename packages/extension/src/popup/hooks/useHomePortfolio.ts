import { useCallback, useEffect, useRef, useState } from 'react'
import type { PortfolioReadModel } from '@/core/portfolio'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { useSettingsStore } from '@/store/settings-store'
import { initializeDefaultIntentsAssets } from '@/popup/services/intents-asset-manager-client'
import {
  isPortfolioModelForScope,
  readCachedPortfolio,
  refreshPortfolioFromCache
} from '@/popup/services/portfolio-cache'
import { usePortfolioUpdates } from './usePortfolioUpdates'

export function useHomePortfolio(walletId: string | null, accountId: string | null) {
  const requestSequence = useRef(0)
  const scopeKey = JSON.stringify([walletId, accountId])
  const mountedScopeKey = useRef(scopeKey)
  const [model, setModel] = useState<PortfolioReadModel | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )

  const load = useCallback(
    async (forceDiscovery = false) => {
      const request = ++requestSequence.current
      setStatus('loading')
      let cachedModel: PortfolioReadModel | null = null
      let nextStatus: 'ready' | 'error' = 'error'
      try {
        if (!walletId || !accountId) return
        cachedModel = await readCachedPortfolio({ walletId, accountId })
        if (request !== requestSequence.current) return
        if (cachedModel) {
          setModel(cachedModel)
          nextStatus = 'ready'
        }
      } catch {
        // A refresh can still recover when the local projection is temporarily unavailable.
      }

      try {
        const refreshed = await refreshPortfolioFromCache(
          {
            walletId: walletId ?? '',
            accountId: accountId ?? '',
            endpointRuntimeKey: chainEndpointRuntimeKey
          },
          cachedModel,
          { forceDiscovery, forceRefresh: forceDiscovery }
        )
        if (request !== requestSequence.current) return
        if (refreshed) {
          setModel(refreshed)
          nextStatus = 'ready'
        }
      } catch {
        // A valid persistent cache remains usable when its background refresh fails.
      }

      if (request !== requestSequence.current) return
      setStatus(nextStatus)
    },
    [accountId, chainEndpointRuntimeKey, walletId]
  )

  const readLatest = useCallback(async () => {
    const request = requestSequence.current
    try {
      if (!walletId || !accountId) return
      const latest = await readCachedPortfolio({ walletId, accountId })
      if (request !== requestSequence.current) return
      if (!isPortfolioModelForScope(latest, walletId, accountId)) return
      setModel(latest)
      setStatus('ready')
    } catch {
      if (request === requestSequence.current && !model) setStatus('error')
    }
  }, [accountId, model, walletId])

  useEffect(() => {
    const scopeChanged = mountedScopeKey.current !== scopeKey
    mountedScopeKey.current = scopeKey
    if (scopeChanged) setModel(null)
    if (!walletId || !accountId) {
      setStatus('ready')
      return
    }
    let active = true
    const initialLoad = load()
    void initializeDefaultIntentsAssets()
      .then(async initialized => {
        if (!initialized || !active) return
        await initialLoad.catch(() => {})
        if (active) await load()
      })
      .catch(() => {})
    return () => {
      active = false
      requestSequence.current += 1
    }
  }, [walletId, accountId, load, scopeKey])

  usePortfolioUpdates(walletId, accountId, readLatest)

  return {
    model: isPortfolioModelForScope(model, walletId, accountId) ? model : null,
    status,
    refresh: load
  }
}
