import { useCallback, useEffect, useRef, useState } from 'react'
import { DedupPromise } from '@/lib/async-utils'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import {
  confidentialFundingClient,
  type ConfidentialBalance,
  type ConfidentialBalanceErrorCode
} from '@/popup/services/confidential-funding-client'
import { usePortfolioUpdates } from './usePortfolioUpdates'
import type { Network } from '@/types/wallet'

const BALANCE_REUSE_MS = 30_000

type BalanceScope = Readonly<{ network: Network; keyDomainId: string; accountId: string }>
type BalanceCache = {
  balances: readonly ConfidentialBalance[] | null
  refreshedAt: number
  version: number
  request: DedupPromise<readonly ConfidentialBalance[]>
  listeners: Set<() => void>
}

const caches = new Map<string, BalanceCache>()
let invalidationListenerInstalled = false

function listenForInvalidation(): void {
  if (invalidationListenerInstalled) return
  invalidationListenerInstalled = true
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
    if (!message || typeof message !== 'object') return
    const update = message as { type?: unknown; walletId?: unknown; accountId?: unknown }
    if (
      update.type !== 'PORTFOLIO_UPDATED' ||
      typeof update.walletId !== 'string' ||
      typeof update.accountId !== 'string'
    )
      return
    for (const [key, cache] of caches) {
      if (key.endsWith(`:${update.walletId}:${update.accountId}`)) {
        cache.refreshedAt = 0
        cache.version += 1
      }
    }
  })
}

function getCache(key: string): BalanceCache {
  let cache = caches.get(key)
  if (!cache) {
    cache = {
      balances: null,
      refreshedAt: 0,
      version: 0,
      request: new DedupPromise(),
      listeners: new Set()
    }
    caches.set(key, cache)
  }
  return cache
}

export function useShieldBalances({
  active,
  enabled,
  scopeKey,
  scope,
  refreshPortfolio,
  readProjection,
  authorizeOnMount = true
}: Readonly<{
  active: boolean
  enabled: boolean
  scopeKey: string
  scope: BalanceScope | null
  refreshPortfolio: (force?: boolean) => Promise<void>
  readProjection?: () => Promise<void>
  authorizeOnMount?: boolean
}>) {
  const cache = getCache(scopeKey)
  const [, setRevision] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<ConfidentialBalanceErrorCode | null>(null)
  const mounted = useRef(false)
  const currentKey = useRef(scopeKey)
  const activeRef = useRef(active)
  const refreshPortfolioRef = useRef(refreshPortfolio)
  const readProjectionRef = useRef(readProjection)
  currentKey.current = scopeKey
  activeRef.current = active
  refreshPortfolioRef.current = refreshPortfolio
  readProjectionRef.current = readProjection

  useEffect(listenForInvalidation, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const notify = () => setRevision(value => value + 1)
    cache.listeners.add(notify)
    return () => {
      cache.listeners.delete(notify)
    }
  }, [cache])

  useEffect(() => {
    setConnecting(false)
    setError(null)
    setErrorCode(null)
  }, [scopeKey])

  const refreshBalances = useCallback(
    async (force = true, authorize = true, notifyPortfolio = true) => {
      if (!scope || !enabled || !activeRef.current) return false
      const age = Date.now() - cache.refreshedAt
      if (!force && cache.balances && age >= 0 && age < BALANCE_REUSE_MS) return true
      const version = cache.version
      if (mounted.current && currentKey.current === scopeKey) {
        setConnecting(true)
        setError(null)
        setErrorCode(null)
      }
      try {
        await cache.request.run(
          () => confidentialFundingClient.refreshBalances(scope, authorize, notifyPortfolio),
          value => {
            if (cache.version !== version) return
            cache.balances = value
            cache.refreshedAt = Date.now()
            for (const notify of cache.listeners) notify()
          }
        )
        if (cache.refreshedAt === 0) return await refreshBalances(true, false, false)
        if (mounted.current && currentKey.current === scopeKey && activeRef.current) {
          if (readProjectionRef.current) void readProjectionRef.current().catch(() => {})
          else void refreshPortfolioRef.current(force).catch(() => {})
        }
        return true
      } catch (cause) {
        if (cache.version !== version) return await refreshBalances(true, false, false)
        if (mounted.current && currentKey.current === scopeKey) {
          setError(cause instanceof Error ? cause.message : 'Shield balance unavailable')
          const code =
            cause instanceof Error && 'balanceErrorCode' in cause ? cause.balanceErrorCode : null
          setErrorCode(
            code === 'authorization_required' ||
              code === 'account_unavailable' ||
              code === 'balance_unavailable'
              ? code
              : 'balance_unavailable'
          )
        }
        return false
      } finally {
        if (mounted.current && currentKey.current === scopeKey) setConnecting(false)
      }
    },
    [scopeKey, scope?.network, scope?.keyDomainId, scope?.accountId, enabled, cache]
  )

  useEffect(() => {
    if (active) void refreshBalances(false, authorizeOnMount)
  }, [active, authorizeOnMount, refreshBalances])

  usePortfolioUpdates(scope?.keyDomainId ?? null, scope?.accountId ?? null, () => {
    if (activeRef.current) return refreshBalances(true, false, false).then(() => {})
  })

  return { balances: cache.balances, connecting, error, errorCode, refreshBalances }
}
