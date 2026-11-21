import type { PortfolioReadModel } from '@/core/portfolio'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import type { Network } from '@/types/wallet'
import { readCachedPortfolio } from './portfolio-cache'
import {
  balanceRefreshIsReady,
  balanceRefreshRequestKey,
  runBalanceRefresh,
  type BalanceRefreshRequest
} from './balance-refresh-adapters'

export interface PortfolioSnapshotScope {
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
  readonly endpointRuntimeKey: string
}

export interface PortfolioSnapshot {
  readonly model: PortfolioReadModel | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly settled: boolean
}

interface Entry {
  readonly scope: PortfolioSnapshotScope
  snapshot: PortfolioSnapshot
  readonly listeners: Set<() => void>
  read?: Promise<PortfolioReadModel | null>
  readonly refreshes: Map<string, Promise<boolean>>
}

const emptySnapshot: PortfolioSnapshot = Object.freeze({
  model: null,
  status: 'ready',
  settled: true
})
const entries = new Map<string, Entry>()
let listenerInstalled = false

export function portfolioSnapshotKey(scope: PortfolioSnapshotScope): string {
  return JSON.stringify([scope.network, scope.walletId, scope.accountId, scope.endpointRuntimeKey])
}

function getEntry(key: string, scope?: PortfolioSnapshotScope): Entry | undefined {
  const existing = entries.get(key)
  if (existing || !scope) return existing
  const entry: Entry = {
    scope,
    snapshot: { model: null, status: 'loading', settled: false },
    listeners: new Set(),
    refreshes: new Map()
  }
  entries.set(key, entry)
  return entry
}

function publish(entry: Entry, snapshot: PortfolioSnapshot): void {
  if (
    entry.snapshot.model === snapshot.model &&
    entry.snapshot.status === snapshot.status &&
    entry.snapshot.settled === snapshot.settled
  )
    return
  entry.snapshot = snapshot
  entry.listeners.forEach(listener => listener())
}

function scopeIsActive(entry: Entry): boolean {
  const wallet = useWalletStore.getState()
  const hasActiveAccount = wallet.currentWalletId !== null || wallet.currentAccountId !== null
  return (
    wallet.currentNetwork === entry.scope.network &&
    (!hasActiveAccount ||
      (wallet.currentWalletId === entry.scope.walletId &&
        wallet.currentAccountId === entry.scope.accountId)) &&
    getChainEndpointRuntimeKey(useSettingsStore.getState().chainEndpointSettings) ===
      entry.scope.endpointRuntimeKey
  )
}

function onPortfolioUpdated(message: unknown, sender: chrome.runtime.MessageSender): void {
  if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
  if (
    typeof message !== 'object' ||
    !message ||
    (message as { type?: unknown }).type !== 'PORTFOLIO_UPDATED'
  )
    return
  const update = message as { walletId?: unknown; accountId?: unknown }
  for (const [key, entry] of entries) {
    if (
      entry.listeners.size > 0 &&
      entry.scope.walletId === update.walletId &&
      entry.scope.accountId === update.accountId &&
      scopeIsActive(entry)
    )
      void readPortfolioSnapshot(key, true)
  }
}

export function subscribePortfolioSnapshot(key: string, listener: () => void): () => void {
  const entry = entries.get(key)
  if (!entry) return () => {}
  entry.listeners.add(listener)
  if (!listenerInstalled) {
    chrome.runtime.onMessage.addListener(onPortfolioUpdated)
    listenerInstalled = true
  }
  return () => {
    entry.listeners.delete(listener)
    if (listenerInstalled && [...entries.values()].every(item => item.listeners.size === 0)) {
      chrome.runtime.onMessage.removeListener(onPortfolioUpdated)
      listenerInstalled = false
    }
  }
}

export function getPortfolioSnapshot(
  key: string,
  scope?: PortfolioSnapshotScope
): PortfolioSnapshot {
  return getEntry(key, scope)?.snapshot ?? emptySnapshot
}

export function readPortfolioSnapshot(
  key: string,
  afterUpdate = false
): Promise<PortfolioReadModel | null> {
  const entry = entries.get(key)
  if (!entry || !scopeIsActive(entry)) return Promise.resolve(null)
  if (entry.read && !afterUpdate) return entry.read
  const operation: Promise<PortfolioReadModel | null> = readCachedPortfolio(entry.scope)
    .then(model => {
      if (!scopeIsActive(entry)) return null
      if (entry.read !== operation) return entry.read ?? entry.snapshot.model
      if (model) publish(entry, { model, status: 'ready', settled: true })
      return model
    })
    .catch(() => {
      if (!scopeIsActive(entry)) return null
      if (entry.read !== operation) return entry.read ?? entry.snapshot.model
      if (!entry.snapshot.model && entry.refreshes.size === 0) {
        publish(entry, { model: null, status: 'error', settled: true })
      }
      return entry.snapshot.model
    })
    .finally(() => {
      if (entry.read === operation) entry.read = undefined
    })
  entry.read = operation
  return operation
}

export function refreshPortfolioSnapshot(
  key: string,
  force = false,
  options: {
    readonly chainIds?: readonly string[]
    readonly additionalChainIds?: readonly string[]
    readonly forceDiscovery?: boolean
    readonly refreshConfidential?: boolean
  } = {}
): Promise<boolean> {
  return refreshBalanceSnapshot(key, { source: 'chain', force, ...options }).catch(() => false)
}

export function refreshBalanceSnapshot(
  key: string,
  request: BalanceRefreshRequest
): Promise<boolean> {
  const entry = entries.get(key)
  if (!entry || !scopeIsActive(entry)) return Promise.resolve(false)
  const requestKey = balanceRefreshRequestKey(request)
  const pending = entry.refreshes.get(requestKey)
  if (pending) return pending
  const run = Promise.resolve().then(async () => {
    if (!scopeIsActive(entry)) return false
    if (!entry.snapshot.model) {
      publish(entry, { ...entry.snapshot, status: 'loading', settled: false })
    }
    await runBalanceRefresh(entry.scope, entry.snapshot.model, request)
    if (!scopeIsActive(entry)) return false
    let model = await readPortfolioSnapshot(key, true)
    if (!scopeIsActive(entry)) return false
    if (!balanceRefreshIsReady(request, model) && request.source === 'near-confidential') {
      model = await readPortfolioSnapshot(key, true)
    }
    if (!scopeIsActive(entry)) return false
    if (!balanceRefreshIsReady(request, model)) {
      if (request.source === 'near-confidential') throw new Error('Shield balance unavailable')
      return false
    }
    return true
  })
  const operation = run.finally(() => {
    entry.refreshes.delete(requestKey)
    if (
      scopeIsActive(entry) &&
      !entry.snapshot.model &&
      entry.refreshes.size === 0 &&
      !entry.read
    ) {
      publish(entry, { model: null, status: 'error', settled: true })
    }
  })
  entry.refreshes.set(requestKey, operation)
  return operation
}
