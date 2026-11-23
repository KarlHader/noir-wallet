import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfidentialBalanceErrorCode } from '@/popup/services/confidential-funding-client'
import { usePortfolioSnapshot } from './usePortfolioSnapshot'
import type { Network } from '@/types/wallet'

type BalanceScope = Readonly<{ network: Network; keyDomainId: string; accountId: string }>

export function useShieldBalances({
  active,
  enabled,
  scopeKey,
  scope,
  authorizeOnMount = true
}: Readonly<{
  active: boolean
  enabled: boolean
  scopeKey: string
  scope: BalanceScope | null
  authorizeOnMount?: boolean
}>) {
  const {
    model,
    settled,
    scopeKey: snapshotKey,
    refreshSource
  } = usePortfolioSnapshot(scope?.keyDomainId ?? null, scope?.accountId ?? null, {
    enabled: active && enabled,
    autoRefresh: false
  })
  const lifecycleKey = JSON.stringify([scopeKey, snapshotKey])
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<ConfidentialBalanceErrorCode | null>(null)
  const [autoRecoveringKey, setAutoRecoveringKey] = useState<string | null>(null)
  const currentKey = useRef(lifecycleKey)
  const currentActive = useRef(active && enabled)
  const autoAttemptedKey = useRef<string | null>(null)
  const cancelAutoRecovery = useRef<(() => void) | null>(null)
  const lastErrorCode = useRef<ConfidentialBalanceErrorCode | null>(null)
  const inFlight = useRef<{ key: string; promise: Promise<boolean> } | null>(null)
  const activeRequest = useRef(0)
  currentKey.current = lifecycleKey
  currentActive.current = active && enabled

  const confidential = model?.confidential
  const freshAssets =
    confidential?.status === 'ready' && confidential.freshness === 'fresh'
      ? confidential.assets
      : null
  const balances = useMemo(
    () =>
      freshAssets?.map(asset => ({ tokenId: asset.tokenId, available: asset.availableRaw })) ??
      null,
    [freshAssets]
  )
  const spendableBalances = useMemo(
    () =>
      freshAssets?.map(asset => ({
        tokenId: asset.tokenId,
        available: asset.spendableRaw ?? asset.availableRaw
      })) ?? null,
    [freshAssets]
  )
  const autoRecovering = active && enabled && autoRecoveringKey === lifecycleKey && !balances

  useEffect(() => {
    setConnecting(false)
    setError(null)
    setErrorCode(null)
    lastErrorCode.current = null
  }, [lifecycleKey])

  useEffect(() => {
    currentActive.current = active && enabled
    if (!active || !enabled) {
      autoAttemptedKey.current = null
      setConnecting(false)
      setError(null)
      setErrorCode(null)
      lastErrorCode.current = null
    }
    return () => {
      currentActive.current = false
    }
  }, [active, enabled, lifecycleKey])

  const refreshBalances = useCallback(
    (
      force = true,
      authorize = true,
      notifyPortfolio = true,
      automatic = false
    ): Promise<boolean> => {
      if (!scope || !enabled || !active) return Promise.resolve(false)
      if (!automatic) cancelAutoRecovery.current?.()
      if (!force && balances) return Promise.resolve(true)
      const requestKey = JSON.stringify([lifecycleKey, authorize, notifyPortfolio])
      if (inFlight.current?.key === requestKey) return inFlight.current.promise
      const operationId = ++activeRequest.current
      const request = (async () => {
        setConnecting(true)
        setError(null)
        setErrorCode(null)
        lastErrorCode.current = null
        try {
          const refreshed = await refreshSource({
            source: 'near-confidential',
            authorize,
            notifyPortfolio
          })
          if (!refreshed) {
            throw new Error('Shield balance unavailable')
          }
          return true
        } catch (cause) {
          const code =
            cause instanceof Error && 'balanceErrorCode' in cause ? cause.balanceErrorCode : null
          const classifiedCode =
            code === 'authorization_required' ||
            code === 'account_unavailable' ||
            code === 'balance_unavailable'
              ? code
              : 'balance_unavailable'
          if (
            currentKey.current === lifecycleKey &&
            currentActive.current &&
            activeRequest.current === operationId
          ) {
            lastErrorCode.current = classifiedCode
            setError(cause instanceof Error ? cause.message : 'Shield balance unavailable')
            setErrorCode(classifiedCode)
          }
          return false
        } finally {
          if (
            currentKey.current === lifecycleKey &&
            currentActive.current &&
            activeRequest.current === operationId
          )
            setConnecting(false)
        }
      })()
      inFlight.current = { key: requestKey, promise: request }
      void request.finally(() => {
        if (inFlight.current?.promise === request) inFlight.current = null
      })
      return request
    },
    [
      active,
      balances,
      enabled,
      refreshSource,
      scope?.network,
      scope?.keyDomainId,
      scope?.accountId,
      lifecycleKey
    ]
  )

  useEffect(() => {
    if (
      !active ||
      !enabled ||
      !scope ||
      !authorizeOnMount ||
      !settled ||
      balances ||
      autoAttemptedKey.current === lifecycleKey
    )
      return
    autoAttemptedKey.current = lifecycleKey
    let cancelled = false
    let started = false
    let retryTimer: number | null = null
    let retries = 0
    const stop = () => {
      cancelled = true
      if (!started && autoAttemptedKey.current === lifecycleKey) autoAttemptedKey.current = null
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      if (cancelAutoRecovery.current === stop) cancelAutoRecovery.current = null
      setAutoRecoveringKey(current => (current === lifecycleKey ? null : current))
    }
    cancelAutoRecovery.current = stop
    const attempt = async (authorize: boolean) => {
      const success = await refreshBalances(false, authorize, true, true)
      if (cancelled) return
      if (success || lastErrorCode.current !== 'balance_unavailable' || retries >= 3) {
        stop()
        return
      }
      retries += 1
      retryTimer = window.setTimeout(
        () => {
          retryTimer = null
          void attempt(false)
        },
        2000 * 2 ** (retries - 1)
      )
    }
    queueMicrotask(() => {
      if (cancelled) return
      started = true
      setAutoRecoveringKey(lifecycleKey)
      void attempt(true)
    })
    return stop
  }, [active, enabled, authorizeOnMount, settled, Boolean(balances), lifecycleKey, refreshBalances])

  return {
    balances,
    spendableBalances,
    settled,
    loading:
      active &&
      enabled &&
      scope !== null &&
      (!settled ||
        connecting ||
        autoRecovering ||
        (authorizeOnMount && !balances && autoAttemptedKey.current !== lifecycleKey)),
    connecting: connecting || autoRecovering,
    error: autoRecovering ? null : error,
    errorCode: autoRecovering ? null : errorCode,
    refreshBalances
  }
}
