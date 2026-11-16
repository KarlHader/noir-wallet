import { useCallback, useEffect, useRef, useState } from 'react'
import {
  confidentialFundingClient,
  type ConfidentialBalanceErrorCode
} from '@/popup/services/confidential-funding-client'
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
  refreshPortfolio: (force?: boolean) => Promise<void>
  readProjection?: () => Promise<void>
  authorizeOnMount?: boolean
}>) {
  const { model, settled, readLatest } = usePortfolioSnapshot(
    scope?.keyDomainId ?? null,
    scope?.accountId ?? null,
    { enabled: active && enabled }
  )
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<ConfidentialBalanceErrorCode | null>(null)
  const currentKey = useRef(scopeKey)
  const autoAttemptedKey = useRef<string | null>(null)
  currentKey.current = scopeKey

  const confidential = model?.confidential
  const balances: readonly Readonly<{ tokenId: string; available: string }>[] | null =
    confidential?.status === 'ready' && confidential.freshness === 'fresh'
      ? confidential.assets.map(asset => ({
          tokenId: asset.tokenId,
          available: asset.availableRaw
        }))
      : null

  useEffect(() => {
    setConnecting(false)
    setError(null)
    setErrorCode(null)
  }, [scopeKey])

  const refreshBalances = useCallback(
    async (force = true, authorize = true, notifyPortfolio = true) => {
      if (!scope || !enabled || !active) return false
      if (!force && balances) return true
      const requestKey = scopeKey
      setConnecting(true)
      setError(null)
      setErrorCode(null)
      try {
        await confidentialFundingClient.refreshBalances(scope, authorize, notifyPortfolio)
        let latest = await readLatest()
        if (latest?.confidential?.freshness !== 'fresh') latest = await readLatest()
        if (latest?.confidential?.freshness !== 'fresh') {
          throw new Error('Shield balance unavailable')
        }
        return true
      } catch (cause) {
        if (currentKey.current === requestKey) {
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
        if (currentKey.current === requestKey) setConnecting(false)
      }
    },
    [
      active,
      balances,
      enabled,
      readLatest,
      scope?.network,
      scope?.keyDomainId,
      scope?.accountId,
      scopeKey
    ]
  )

  useEffect(() => {
    if (!active || !authorizeOnMount || !settled || autoAttemptedKey.current === scopeKey) return
    autoAttemptedKey.current = scopeKey
    if (!balances) void refreshBalances(false, true)
  }, [active, authorizeOnMount, settled, Boolean(balances), scopeKey])

  return { balances, settled, connecting, error, errorCode, refreshBalances }
}
