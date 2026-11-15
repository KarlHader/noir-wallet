import { useEffect, useSyncExternalStore } from 'react'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '@/store/settings-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import type { SyncStateSnapshot } from '@/background/sync-scheduler'

const WALLET_STORAGE_KEY = 'wallet_state'
type BalanceReadStatus = 'loading' | 'available' | 'error'
type SyncReadStatus = BalanceReadStatus
let balanceReadState: Readonly<{ scope: string; status: BalanceReadStatus }> = {
  scope: '',
  status: 'loading'
}
const balanceReadListeners = new Set<() => void>()
const balanceReads = new Map<string, Promise<void>>()
const balancePushRevisions = new Map<string, number>()
const syncPushRevisions = new Map<string, number>()
let syncReadState: Readonly<{ scope: string; status: SyncReadStatus }> = {
  scope: '',
  status: 'loading'
}
const syncReadListeners = new Set<() => void>()

function setSyncReadState(scope: string, status: SyncReadStatus): void {
  if (syncReadState.scope === scope && syncReadState.status === status) return
  syncReadState = { scope, status }
  syncReadListeners.forEach(listener => listener())
}

export function useZcashSyncReadStatus(
  network: string,
  walletId: string | null,
  accountId: string | null
): SyncReadStatus {
  const state = useSyncExternalStore(
    listener => {
      syncReadListeners.add(listener)
      return () => syncReadListeners.delete(listener)
    },
    () => syncReadState
  )
  const scope = `${network}:${walletId ?? ''}:${accountId ?? ''}`
  return state.scope === scope ? state.status : 'loading'
}

function applySyncState(
  snapshot: Partial<SyncStateSnapshot>,
  network: string,
  walletId: string,
  accountId: string
): boolean {
  const current = useWalletStore.getState()
  if (
    current.currentNetwork !== network ||
    current.currentWalletId !== walletId ||
    current.currentAccountId !== accountId ||
    snapshot.network !== network ||
    snapshot.walletId !== walletId ||
    (snapshot.accountId !== undefined && snapshot.accountId !== accountId)
  )
    return false
  const patch: Partial<import('@/store/account-data-store').SyncState> = {}
  if (typeof snapshot.isSyncing === 'boolean') patch.isSyncing = snapshot.isSyncing
  if (typeof snapshot.syncProgress === 'number') patch.syncProgress = snapshot.syncProgress
  if (typeof snapshot.currentHeight === 'number') patch.currentHeight = snapshot.currentHeight
  if (typeof snapshot.latestHeight === 'number') patch.latestHeight = snapshot.latestHeight
  if (snapshot.etaMs === null || typeof snapshot.etaMs === 'number') patch.etaMs = snapshot.etaMs
  if (snapshot.syncReason === null || typeof snapshot.syncReason === 'string')
    patch.syncReason = snapshot.syncReason
  if (Object.keys(patch).length === 0) return false
  useAccountDataStore.getState().setWalletSyncStateFor(network, walletId, patch)
  if (typeof snapshot.isSyncing === 'boolean')
    setSyncReadState(`${network}:${walletId}:${accountId}`, 'available')
  return true
}

function setBalanceReadState(scope: string, status: BalanceReadStatus): void {
  if (balanceReadState.scope === scope && balanceReadState.status === status) return
  balanceReadState = { scope, status }
  balanceReadListeners.forEach(listener => listener())
}

export function useZcashBalanceReadStatus(
  network: string,
  walletId: string | null,
  accountId: string | null
) {
  const state = useSyncExternalStore(
    listener => {
      balanceReadListeners.add(listener)
      return () => balanceReadListeners.delete(listener)
    },
    () => balanceReadState
  )
  const scope = `${network}:${walletId ?? ''}:${accountId ?? ''}`
  return state.scope === scope ? state.status : 'loading'
}

export function retryZcashBalanceRead(
  network: string,
  walletId: string,
  accountId: string
): Promise<void> {
  const scope = `${network}:${walletId}:${accountId}`
  const existing = balanceReads.get(scope)
  if (existing) return existing
  const pushRevision = balancePushRevisions.get(scope) ?? 0
  const syncRevision = syncPushRevisions.get(scope) ?? 0
  setBalanceReadState(scope, 'loading')
  setSyncReadState(scope, 'loading')
  const request = chrome.runtime
    .sendMessage({ type: 'GET_SYNC_STATE', walletId, accountId })
    .then((snapshot: Partial<SyncStateSnapshot>) => {
      const current = useWalletStore.getState()
      if (
        current.currentNetwork !== network ||
        current.currentWalletId !== walletId ||
        current.currentAccountId !== accountId
      )
        return
      if ((syncPushRevisions.get(scope) ?? 0) === syncRevision) {
        if (
          snapshot.accountId !== accountId ||
          typeof snapshot.isSyncing !== 'boolean' ||
          !applySyncState(snapshot, network, walletId, accountId)
        )
          setSyncReadState(scope, 'error')
      }
      if ((balancePushRevisions.get(scope) ?? 0) !== pushRevision) return
      if (
        snapshot.network !== network ||
        snapshot.walletId !== walletId ||
        snapshot.accountId !== accountId ||
        !snapshot.balance
      ) {
        if (balanceReadState.scope === scope && balanceReadState.status !== 'available')
          setBalanceReadState(scope, 'error')
        return
      }
      useAccountDataStore.getState().setBalanceFor(network, walletId, accountId, snapshot.balance)
      setBalanceReadState(scope, 'available')
    })
    .catch(() => {
      if ((syncPushRevisions.get(scope) ?? 0) === syncRevision && syncReadState.scope === scope)
        setSyncReadState(scope, 'error')
      if (
        (balancePushRevisions.get(scope) ?? 0) === pushRevision &&
        balanceReadState.scope === scope &&
        balanceReadState.status !== 'available'
      )
        setBalanceReadState(scope, 'error')
    })
    .finally(() => balanceReads.delete(scope))
  balanceReads.set(scope, request)
  return request
}

function readWalletScope(): string | null {
  const { currentWalletId, currentAccountId } = useWalletStore.getState()
  return currentWalletId && currentAccountId ? `${currentWalletId}:${currentAccountId}` : null
}

/** Keeps long-lived extension pages aligned with authoritative Background writes. */
export function usePersistedExtensionContextSync(): void {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)

  useEffect(() => {
    let queue: Promise<void> = Promise.resolve()

    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return
      const walletChanged = Object.prototype.hasOwnProperty.call(changes, WALLET_STORAGE_KEY)
      const settingsChanged = Object.prototype.hasOwnProperty.call(changes, SETTINGS_STORAGE_KEY)
      if (!walletChanged && !settingsChanged) return

      queue = queue
        .catch(() => {})
        .then(async () => {
          const previousWalletScope = readWalletScope()
          if (walletChanged) await rehydrateWalletStore()
          if (settingsChanged) await useSettingsStore.persist.rehydrate()

          if (walletChanged && readWalletScope() !== previousWalletScope) {
            useTransactionResultStore.getState().clear()
          }
        })
        .catch(error => {
          console.error('[Popup] Failed to synchronize persisted wallet context:', error)
        })
    }

    chrome.storage.onChanged.addListener(handleStorageChanged)
    return () => chrome.storage.onChanged.removeListener(handleStorageChanged)
  }, [])

  useEffect(() => {
    if (!walletId || !accountId) return
    let cancelled = false
    const applyBalance = (snapshot: Partial<SyncStateSnapshot>) => {
      const current = useWalletStore.getState()
      if (
        cancelled ||
        current.currentNetwork !== network ||
        current.currentWalletId !== walletId ||
        current.currentAccountId !== accountId ||
        snapshot.walletId !== walletId ||
        snapshot.accountId !== accountId ||
        !snapshot.balance
      ) {
        return
      }
      const scope = `${network}:${walletId}:${accountId}`
      balancePushRevisions.set(scope, (balancePushRevisions.get(scope) ?? 0) + 1)
      useAccountDataStore.getState().setBalanceFor(network, walletId, accountId, snapshot.balance)
      setBalanceReadState(scope, 'available')
    }
    const listener = (
      message: Partial<SyncStateSnapshot> & { type?: string },
      sender: chrome.runtime.MessageSender
    ) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (message.type !== 'SYNC_PROGRESS' || message.walletId !== walletId) return
      if (message.network !== network) return
      const scope = `${network}:${walletId}:${accountId}`
      if (message.accountId !== undefined && message.accountId !== accountId) return
      applySyncState(message, network, walletId, accountId)
      if (typeof message.isSyncing === 'boolean')
        syncPushRevisions.set(scope, (syncPushRevisions.get(scope) ?? 0) + 1)
      if (message.balance) applyBalance(message)
    }

    chrome.runtime.onMessage.addListener(listener)
    const scope = `${network}:${walletId}:${accountId}`
    if (useAccountDataStore.getState().getBalance(network, walletId, accountId)) {
      setBalanceReadState(scope, 'available')
    }
    void retryZcashBalanceRead(network, walletId, accountId)
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [walletId, accountId, network])
}
