import { useCallback, useEffect, useMemo, useState } from 'react'

import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeClient } from '@/popup/services/dapp-execution-mode-client'

interface WalletActionExecutionModeState {
  readonly scopeKey: string | null
  readonly mode: DAppExecutionMode
  readonly privateAvailable: boolean
  readonly loading: boolean
  readonly selectedByUser: boolean
}

export function useWalletActionExecutionMode(
  enabled: boolean,
  walletId: string | null | undefined,
  accountId: string | null | undefined
) {
  const scopeKey = enabled && walletId && accountId ? `${walletId}:${accountId}` : null
  const [state, setState] = useState<WalletActionExecutionModeState>({
    scopeKey: null,
    mode: 'main',
    privateAvailable: false,
    loading: Boolean(scopeKey),
    selectedByUser: false
  })

  useEffect(() => {
    let cancelled = false
    if (!scopeKey) {
      setState({
        scopeKey: null,
        mode: 'main',
        privateAvailable: false,
        loading: false,
        selectedByUser: false
      })
      return () => {
        cancelled = true
      }
    }

    setState({
      scopeKey,
      mode: 'main',
      privateAvailable: false,
      loading: true,
      selectedByUser: false
    })
    void dappExecutionModeClient
      .read()
      .then(next => {
        if (cancelled) return
        setState(current => ({
          scopeKey,
          mode: current.scopeKey === scopeKey && current.selectedByUser ? current.mode : next.mode,
          privateAvailable: next.privateAvailable,
          loading: false,
          selectedByUser: current.scopeKey === scopeKey && current.selectedByUser
        }))
      })
      .catch(() => {
        if (cancelled) return
        setState(current => ({
          scopeKey,
          mode: current.scopeKey === scopeKey && current.selectedByUser ? current.mode : 'main',
          privateAvailable: false,
          loading: false,
          selectedByUser: current.scopeKey === scopeKey && current.selectedByUser
        }))
      })

    return () => {
      cancelled = true
    }
  }, [scopeKey])

  const setMode = useCallback(
    (mode: DAppExecutionMode) => {
      if (!scopeKey) return
      setState(current => ({
        scopeKey,
        mode,
        privateAvailable: current.scopeKey === scopeKey && current.privateAvailable,
        loading: false,
        selectedByUser: true
      }))
    },
    [scopeKey]
  )

  return useMemo(
    () => ({
      mode: state.scopeKey === scopeKey ? state.mode : 'main',
      privateAvailable: state.scopeKey === scopeKey && state.privateAvailable,
      loading: state.scopeKey !== scopeKey || state.loading,
      setMode
    }),
    [scopeKey, setMode, state]
  )
}
