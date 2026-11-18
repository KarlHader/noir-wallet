import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  NoirPublicAccount,
  NoirPublicAssets
} from '@/core/services/noir-protocol/public/types'
import { noirPublicWalletClient } from '@/popup/services/noir-public-wallet-client'
import { usePortfolioUpdates } from './usePortfolioUpdates'

export function useNoirPublicAssets(
  enabled: boolean,
  scope: string,
  walletId: string | null,
  accountId: string | null
) {
  const sequence = useRef(0)
  const [account, setAccount] = useState<NoirPublicAccount | null>(null)
  const [assets, setAssets] = useState<NoirPublicAssets | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadedScope, setLoadedScope] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    let cachedLoaded = false
    setStatus('loading')
    setError(null)
    try {
      const nextAccount = await noirPublicWalletClient.getAccount()
      if (request !== sequence.current) return
      setLoadedScope(scope)
      setAccount(nextAccount)
      if (nextAccount?.status === 'active') {
        const apply = (result: NoirPublicAssets) => {
          if (
            result.account.address !== nextAccount.address ||
            result.account.network !== nextAccount.network
          ) {
            throw new Error('Public account changed. Refresh assets again.')
          }
          setAccount(result.account)
          setAssets(result)
        }
        try {
          const cached = await noirPublicWalletClient.getAssets(false)
          if (request !== sequence.current) return
          apply(cached)
          cachedLoaded = true
          setStatus('ready')
        } catch {
          // A fresh read can recover when the cache is unavailable.
        }
        const result = await noirPublicWalletClient.getAssets(true)
        if (request !== sequence.current) return
        apply(result)
      } else {
        setAssets(null)
      }
      setStatus('ready')
    } catch (cause) {
      if (request !== sequence.current) return
      setLoadedScope(scope)
      setError(cause instanceof Error ? cause.message : 'Unable to load Public assets')
      setStatus(cachedLoaded ? 'ready' : 'error')
    }
  }, [scope])

  useEffect(() => {
    sequence.current += 1
    setLoadedScope(null)
    setAccount(null)
    setAssets(null)
    if (enabled && scope) void refresh()
    return () => {
      sequence.current += 1
    }
  }, [enabled, scope, refresh])

  usePortfolioUpdates(enabled ? walletId : null, enabled ? accountId : null, refresh)

  const visible = enabled && loadedScope === scope
  useEffect(() => {
    if (!visible || account?.status !== 'activating') return
    const timer = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(timer)
  }, [account?.status, refresh, visible])

  return {
    account: visible ? account : null,
    assets: visible ? assets : null,
    status: visible ? status : ('loading' as const),
    error: visible ? error : null,
    refresh
  }
}
