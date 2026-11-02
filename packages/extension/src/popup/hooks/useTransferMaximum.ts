import { useEffect, useRef, useState } from 'react'
import type { QuoteDepositMaximum } from '@/popup/services/quote-deposit-transfer-client'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'

export function useTransferMaximum(options: {
  readonly enabled: boolean
  readonly requestKey: string
  readonly estimate: () => Promise<QuoteDepositMaximum>
  readonly fallback?: () => QuoteDepositMaximum
}) {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const endpoints = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const requestKey = JSON.stringify([walletId, accountId, network, endpoints, options.requestKey])
  const latest = useRef(options)
  latest.current = options
  const sequence = useRef(0)
  const [state, setState] = useState<{
    key: string
    value: QuoteDepositMaximum | null
    loading: boolean
    fallbackUsed: boolean
    error: unknown
  }>({ key: '', value: null, loading: false, fallbackUsed: false, error: null })
  useEffect(() => {
    sequence.current += 1
    return () => {
      sequence.current += 1
    }
  }, [options.enabled, requestKey])

  const request = async () => {
    if (!latest.current.enabled) return
    const current = ++sequence.current
    setState({ key: requestKey, value: null, loading: true, fallbackUsed: false, error: null })
    try {
      const value = await latest.current.estimate()
      if (current === sequence.current)
        setState({ key: requestKey, value, loading: false, fallbackUsed: false, error: null })
    } catch (error) {
      if (current === sequence.current)
        setState({
          key: requestKey,
          value: latest.current.fallback?.() ?? null,
          loading: false,
          fallbackUsed: Boolean(latest.current.fallback),
          error
        })
    }
  }
  const current = options.enabled && state.key === requestKey
  return {
    value: current ? state.value : null,
    loading: current && state.loading,
    fallbackUsed: current && state.fallbackUsed,
    error: current ? state.error : null,
    update: (value: QuoteDepositMaximum) => {
      sequence.current += 1
      setState({ key: requestKey, value, loading: false, fallbackUsed: false, error: null })
    },
    request
  }
}
