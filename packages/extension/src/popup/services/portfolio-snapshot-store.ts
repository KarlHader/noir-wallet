import type { PortfolioReadModel } from '@/core/portfolio'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { useSettingsStore } from '@/store/settings-store'
import { useWalletStore } from '@/store/wallet-store'
import { readCachedPortfolio, refreshPortfolioFromCache } from './portfolio-cache'

export interface PortfolioSnapshotScope {
  readonly network: string
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
  refreshTail?: Promise<boolean>
  readonly refreshes: Map<string, Promise<boolean>>
  revision: number
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
    refreshes: new Map(),
    revision: 0
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
      void readPortfolioSnapshot(key).catch(() => {})
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

export function readPortfolioSnapshot(key: string): Promise<PortfolioReadModel | null> {
  const entry = entries.get(key)
  if (!entry || !scopeIsActive(entry)) return Promise.resolve(null)
  if (entry.refreshTail) return entry.refreshTail.then(() => readPortfolioSnapshot(key))
  if (entry.read) return entry.read
  const revision = entry.revision
  const operation = readCachedPortfolio(entry.scope)
    .then(model => {
      const valid = revision === entry.revision && scopeIsActive(entry)
      if (model && valid) {
        publish(entry, { model, status: 'ready', settled: true })
      }
      return valid ? model : null
    })
    .catch(() => {
      if (revision === entry.revision && scopeIsActive(entry) && !entry.snapshot.model) {
        publish(entry, { model: null, status: 'error', settled: true })
      }
      return null
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
  } = {}
): Promise<boolean> {
  const entry = entries.get(key)
  if (!entry || !scopeIsActive(entry)) return Promise.resolve(false)
  const chainIds = [
    ...new Set([...(options.chainIds ?? []), ...(options.additionalChainIds ?? [])])
  ].sort()
  const requestKey = JSON.stringify([force, options.forceDiscovery === true, chainIds])
  const pending = entry.refreshes.get(requestKey)
  if (pending) return pending
  const previous = entry.refreshTail
  entry.revision += 1
  const run = (previous ?? Promise.resolve(false)).then(async () => {
    if (!scopeIsActive(entry)) return false
    if (!entry.snapshot.model) {
      publish(entry, { ...entry.snapshot, status: 'loading', settled: false })
    }
    try {
      const model = await refreshPortfolioFromCache(entry.scope, entry.snapshot.model, {
        forceRefresh: force,
        allowStaleOnError: false,
        forceDiscovery: options.forceDiscovery,
        refreshChainIds: options.chainIds,
        additionalChainIds: options.additionalChainIds
      })
      entry.revision += 1
      if (!scopeIsActive(entry)) return false
      publish(entry, {
        model: model ?? entry.snapshot.model,
        status: model || entry.snapshot.model ? 'ready' : 'error',
        settled: true
      })
      return model !== null
    } catch {
      entry.revision += 1
      if (!scopeIsActive(entry)) return false
      publish(entry, {
        model: entry.snapshot.model,
        status: entry.snapshot.model ? 'ready' : 'error',
        settled: true
      })
      return false
    }
  })
  const operation = run.finally(() => {
    entry.refreshes.delete(requestKey)
    if (entry.refreshTail === operation) entry.refreshTail = undefined
  })
  entry.refreshes.set(requestKey, operation)
  entry.refreshTail = operation
  return operation
}
