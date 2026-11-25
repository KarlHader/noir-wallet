import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DAPP_EXECUTION_MODE_STORAGE_KEY,
  type DAppExecutionMode,
  type DAppExecutionModeState
} from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeClient } from '@/popup/services/dapp-execution-mode-client'
import type { Network } from '@/types'
import { waitForDelayOrAbort, withTimeout } from '@/lib/async-utils'

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
  const pendingModeWrite = useRef<Promise<DAppExecutionModeState> | null>(null)
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
      const next = await withTimeout(dappExecutionModeClient.read(), 10_000, 'Read wallet mode')
      if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
        confirmedModes.set(scopeKey, next)
        setScopedState({ scopeKey, state: next })
        setConfirmedScopeKey(scopeKey)
      }
      return next
    } catch (caught) {
      if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
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
    const controller = new AbortController()
    const readMode = async () => {
      let attempt = 0
      while (!controller.signal.aborted) {
        try {
          await refresh()
          return
        } catch {
          // A service-worker restart can close a read-only message channel.
          // Keep actions gated until Background confirms this Account's mode.
          await waitForDelayOrAbort(
            Math.min(500 * 2 ** Math.min(attempt++, 4), 5_000),
            controller.signal
          )
        }
      }
    }
    void readMode()
    const onStorageChanged = async (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (!scopeKey || area !== 'local' || !(DAPP_EXECUTION_MODE_STORAGE_KEY in changes)) return
      // Let this window apply its write response before re-reading the saved mode.
      while (!controller.signal.aborted && pendingModeWrite.current) {
        await pendingModeWrite.current.catch(() => {})
      }
      if (!controller.signal.aborted) await refresh().catch(() => {})
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    return () => {
      controller.abort()
      requestVersion.current += 1
      chrome.storage.onChanged.removeListener(onStorageChanged)
    }
  }, [refresh, scopeKey])

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
      const write = dappExecutionModeClient.set(mode, options)
      pendingModeWrite.current = write
      try {
        const next = await write
        if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
          confirmedModes.set(scopeKey, next)
          setScopedState({ scopeKey, state: next })
          setConfirmedScopeKey(scopeKey)
          setLoading(false)
        }
        return next
      } catch (caught) {
        if (version === requestVersion.current && latestScopeKey.current === scopeKey) {
          // A queued write may supersede the previous write's storage-triggered read.
          void refresh().catch(() => {})
          setError(caught instanceof Error ? caught.message : 'Unable to change dApp account mode')
        }
        throw caught
      } finally {
        if (pendingModeWrite.current === write) {
          pendingModeWrite.current = null
          setUpdating(false)
        }
      }
    },
    [refresh, scopeKey]
  )

  return Object.freeze({ state, loading, ready, updating, error, refresh, setMode })
}
