import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { QuoteDepositMaximum } from '@/popup/services/quote-deposit-transfer-client'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { TransferMaximumEstimateCache } from '@/popup/services/transfer-maximum-cache'

export function useTransferMaximum(options: {
  readonly enabled: boolean
  readonly requestKey: string
  readonly estimate: () => Promise<QuoteDepositMaximum>
  readonly fallback?: () => QuoteDepositMaximum
  readonly prefetch?: boolean
}) {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const endpoints = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const requestKey = JSON.stringify([walletId, accountId, network, endpoints, options.requestKey])
  const latest = useRef({ ...options, key: requestKey })
  latest.current = { ...options, key: requestKey }
  const sequence = useRef(0)
  const cache = useRef<TransferMaximumEstimateCache | null>(null)
  if (!cache.current) cache.current = new TransferMaximumEstimateCache()
  const [state, setState] = useState<{
    key: string
    value: QuoteDepositMaximum | null
    loading: boolean
    fallbackUsed: boolean
    error: unknown
  }>({ key: '', value: null, loading: false, fallbackUsed: false, error: null })
  useLayoutEffect(() => {
    sequence.current += 1
    cache.current!.setScope(options.enabled ? requestKey : null)
    setState({ key: requestKey, value: null, loading: false, fallbackUsed: false, error: null })
    return () => {
      sequence.current += 1
      cache.current!.setScope(null)
    }
  }, [options.enabled, requestKey])

  const request = useCallback(async () => {
    if (!latest.current.enabled || latest.current.key !== requestKey) return
    const { estimate, fallback } = latest.current
    const current = ++sequence.current
    const cached = cache.current!.read(requestKey)
    if (!cached)
      setState({ key: requestKey, value: null, loading: true, fallbackUsed: false, error: null })
    try {
      const value = cached ?? (await cache.current!.request(requestKey, estimate))
      if (current === sequence.current)
        setState({
          key: requestKey,
          value: { ...value },
          loading: false,
          fallbackUsed: false,
          error: null
        })
    } catch (error) {
      if (current === sequence.current) {
        let value: QuoteDepositMaximum | null = null
        let failure = error
        try {
          value = fallback?.() ?? null
        } catch (fallbackError) {
          failure = fallbackError
        }
        setState({
          key: requestKey,
          value,
          loading: false,
          fallbackUsed: value !== null,
          error: failure
        })
      }
    }
  }, [requestKey])

  useEffect(() => {
    if (!options.enabled || options.prefetch !== true) return
    // Recipient and route edits can be frequent; a click bypasses this debounce.
    const timer = setTimeout(() => {
      if (latest.current.key !== requestKey || !latest.current.enabled) return
      void cache.current!.request(requestKey, latest.current.estimate).catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [options.enabled, options.prefetch, requestKey])
  useEffect(() => {
    if (!options.enabled || state.key !== requestKey || !state.value?.expiresAt) return
    const timer = setTimeout(
      () => {
        void request()
      },
      Math.max(0, state.value.expiresAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [options.enabled, requestKey, request, state.key, state.value])
  const current = options.enabled && state.key === requestKey
  return {
    value: current ? state.value : null,
    loading: current && state.loading,
    fallbackUsed: current && state.fallbackUsed,
    error: current ? state.error : null,
    update: (value: QuoteDepositMaximum) => {
      if (!latest.current.enabled || latest.current.key !== requestKey) return
      sequence.current += 1
      const currentValue = cache.current!.update(requestKey, value)
      setState({
        key: requestKey,
        value: currentValue,
        loading: false,
        fallbackUsed: false,
        error: null
      })
    },
    request
  }
}
