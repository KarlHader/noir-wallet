import { useCallback, useEffect, useRef, useState } from 'react'

import type { DAppExecutionMode, DAppExecutionModeState } from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeClient } from '@/popup/services/dapp-execution-mode-client'
import type { Network } from '@/types'

const confirmedModes = new Map<string, DAppExecutionModeState>()

export function useDAppExecutionMode(
  enabled: boolean,
  walletId: string | null | undefined,
  accountId: string | null | undefined,
  network: Network
) {
  const scopeKey =
    enabled && walletId && accountId ? JSON.stringify([network, walletId, accountId]) : null
  const [scopedState, setScopedState] = useState(() => ({
    scopeKey,
    state: scopeKey ? (confirmedModes.get(scopeKey) ?? null) : null
  }))
  const [loading, setLoading] = useState(Boolean(enabled && walletId && accountId))
  const [confirmedScopeKey, setConfirmedScopeKey] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const state =
    scopedState.scopeKey === scopeKey
      ? scopedState.state
      : scopeKey
        ? (confirmedModes.get(scopeKey) ?? null)
        : null
  const latestScopeKey = useRef(scopeKey)
  latestScopeKey.current = scopeKey
  const ready = scopeKey !== null && confirmedScopeKey === scopeKey && !loading

  const refresh = useCallback(async () => {
    if (!scopeKey) {
      setScopedState({ scopeKey: null, state: null })
      setConfirmedScopeKey(null)
      setError(null)
      setLoading(false)
      return null
    }
    const version = ++requestVersion.current
    setConfirmedScopeKey(null)
    setLoading(true)
    setError(null)
    try {
      const next = await dappExecutionModeClient.read()
      if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
        confirmedModes.set(scopeKey, next)
        setScopedState({ scopeKey, state: next })
        setConfirmedScopeKey(scopeKey)
      }
      return next
    } catch (caught) {
      if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
        confirmedModes.delete(scopeKey)
        setScopedState({ scopeKey, state: null })
        setConfirmedScopeKey(null)
        setError(caught instanceof Error ? caught.message : 'Unable to read dApp account mode')
      }
      throw caught
    } finally {
      if (version === requestVersion.current && latestScopeKey.current === scopeKey)
        setLoading(false)
    }
  }, [scopeKey])

  useEffect(() => {
    void refresh().catch(() => {})
    return () => {
      requestVersion.current += 1
    }
  }, [refresh])

  const setMode = useCallback(
    async (
      mode: DAppExecutionMode,
      options: Readonly<{
        confirmPrivateSetup?: boolean
        confirmAffectedOperations?: boolean
      }> = {}
    ) => {
      if (!scopeKey) throw new Error('No active dApp account mode scope')
      const version = ++requestVersion.current
      setUpdating(true)
      setError(null)
      try {
        const next = await dappExecutionModeClient.set(mode, options)
        if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
          confirmedModes.set(scopeKey, next)
          setScopedState({ scopeKey, state: next })
        }
        return next
      } catch (caught) {
        if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
          setError(caught instanceof Error ? caught.message : 'Unable to change dApp account mode')
        }
        throw caught
      } finally {
        if (version === requestVersion.current && latestScopeKey.current === scopeKey)
          setUpdating(false)
      }
    },
    [scopeKey]
  )

  return Object.freeze({ state, loading, ready, updating, error, refresh, setMode })
}
