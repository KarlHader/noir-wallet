import {
  activityGraphNotification,
  activityNotificationKey,
  activityReceiptSource,
  collectActivityReceiptNotifications,
  formatActivityNotification,
  PRIVATE_ACTIVITY_NOTIFICATION,
  resolveActivityNotification,
  type ActivityNotificationOutcome
} from '@/core/activity/activity-notification'
import type { ActivityReadModel, ActivityScope } from '@/core/activity'
import {
  getActivityBalanceDomains,
  isExternalShieldDepositActivity,
  type ActivityBalanceDomain
} from '@/core/activity/activity-balance-domains'
import type { AssetDisplayMetadata } from '@/core/chains/domain'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import type { TransactionGraph } from '@/core/transactions/domain'
import { EXTENSION_ACTIVITY_ROUTE, EXTENSION_POPUP_PATH } from '@/config/extension'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { decodePersistedWalletSettings, SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'
import { mapZcashV1TransactionToActivityItem } from '@/infrastructure/activity/zcash-v1-activity-source'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { readActiveStorageV2Snapshot } from '@/core/keyring/application/active-storage-v2-snapshot'
import type { Network, Transaction } from '@/types/wallet'

export const ACTIVITY_RECEIPTS_ALARM = 'activity-receipts'
const NOTIFICATION_PREFIX = 'activity-transaction:'
const TRACKING_EPOCH_KEY = 'activity-notifications-enabled-at'
const MAX_PENDING_RECEIPTS = 2_000
const MAX_DELIVERIES_PER_ACCOUNT = 4_000

type ScopedAccount = ActivityScope & { readonly network: Network }

interface Delivery {
  readonly itemId: string
  readonly domain?: ActivityBalanceDomain
}

interface NotificationState {
  readonly deliveries: Record<string, Delivery>
  readonly receiptBaselines?: Readonly<Record<string, number>>
  readonly pendingReceipts?: readonly string[]
}

interface ActivityNotificationOptions {
  readonly activeScope: () => Promise<ScopedAccount | null>
  readonly hasUnlockSession: () => Promise<boolean>
  readonly assetMetadata: (assetId: string) => AssetDisplayMetadata | undefined
  readonly readActivity: (
    refresh: boolean,
    scope: ScopedAccount
  ) => Promise<ActivityReadModel | null>
}

function matchesScope(left: ScopedAccount | null, right: ScopedAccount): boolean {
  return (
    left?.network === right.network &&
    left.keyDomainId === right.keyDomainId &&
    left.accountId === right.accountId
  )
}

function notificationStateKey(scope: ScopedAccount): string {
  return `activity-notifications:${JSON.stringify([scope.network, scope.keyDomainId, scope.accountId])}`
}

export async function clearActivityNotifications(scope: ActivityScope): Promise<void> {
  const scopes: ScopedAccount[] = [
    { ...scope, network: 'mainnet' },
    { ...scope, network: 'testnet' }
  ]
  const states = await Promise.all(scopes.map(readState))
  await chrome.storage.local.remove(scopes.map(notificationStateKey))
  await Promise.allSettled(
    states.flatMap(state => Object.keys(state.deliveries).map(id => chrome.notifications.clear(id)))
  )
}

async function readState(scope: ScopedAccount): Promise<NotificationState> {
  const key = notificationStateKey(scope)
  return (await chrome.storage.local.get(key))[key] ?? { deliveries: {} }
}

async function notificationId(identity: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return (
    NOTIFICATION_PREFIX +
    Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  )
}

export class ActivityNotifications {
  private tail: Promise<unknown> = Promise.resolve()
  private polling?: Promise<void>
  private epoch?: Promise<number>
  private readonly successfulReads = new Map<string, Map<string, number>>()

  constructor(private readonly options: ActivityNotificationOptions) {}

  historyRead(scope: ScopedAccount, chainId: string, mode?: string): void {
    const key = notificationStateKey(scope)
    const sources = this.successfulReads.get(key) ?? new Map<string, number>()
    sources.set(activityReceiptSource(chainId, mode), Date.now())
    this.successfulReads.set(key, sources)
  }

  async initialize(): Promise<void> {
    await this.enabledAt()
    if (!(await chrome.alarms.get(ACTIVITY_RECEIPTS_ALARM))) {
      await chrome.alarms.create(ACTIVITY_RECEIPTS_ALARM, { periodInMinutes: 5 })
      await this.refreshReceipts()
    }
  }

  async observeGraph(
    network: Network,
    graph: TransactionGraph,
    previous?: TransactionGraph
  ): Promise<void> {
    const outcome = activityGraphNotification(graph)
    if (!outcome || (previous && activityGraphNotification(previous)?.result === outcome.result))
      return
    if (!previous && graph.root.createdAt < (await this.enabledAt())) return
    const scope = { ...graph.root.scope, network }
    await this.deliver(scope, outcome)
  }

  async observeZcash(
    scope: ScopedAccount,
    previous: readonly Transaction[],
    current: readonly Transaction[]
  ): Promise<void> {
    const before = new Map(previous.map(item => [item.id, item.status]))
    for (const transaction of current) {
      const previousStatus = before.get(transaction.id)
      if (
        !previousStatus ||
        previousStatus === transaction.status ||
        previousStatus === 'success' ||
        previousStatus === 'failed' ||
        transaction.type === 'receive' ||
        transaction.id.startsWith('wasm_')
      )
        continue
      try {
        const outcome = resolveActivityNotification(
          mapZcashV1TransactionToActivityItem(transaction, scope)
        )
        if (outcome) await this.deliver(scope, outcome)
      } catch {
        // A legacy record without valid display data cannot prevent other notifications.
      }
    }
  }

  refreshReceipts(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.pollReceipts().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  private async pollReceipts(): Promise<void> {
    const scope = await this.options.activeScope()
    if (!scope) return
    const { keyDomainId, accountId } = scope
    const [activity, epoch, graphs] = await Promise.all([
      this.options.readActivity(true, scope),
      this.enabledAt(),
      new IndexedDbTransactionRepository().list({ scope: { keyDomainId, accountId }, limit: 200 })
    ])
    if (!activity || !matchesScope({ ...activity.scope, network: DEFAULT_NETWORK }, scope)) return
    if (!matchesScope(await this.options.activeScope(), scope)) return

    const outcomes = graphs.flatMap(graph => {
      if (
        graph.root.updatedAt < epoch &&
        !graph.segments.some(segment => segment.role === 'refund' && segment.updatedAt >= epoch)
      )
        return []
      const outcome = activityGraphNotification(graph)
      return outcome ? [outcome] : []
    })
    // The Shield monitor projects a late provider refund onto a previously failed graph.
    for (const item of activity.items) {
      if (item.updatedAt < epoch || !isExternalShieldDepositActivity(item)) continue
      const outcome = resolveActivityNotification(item)
      if (outcome?.result === 'refunded') outcomes.push(outcome)
    }
    await this.enqueue(async () => {
      if (!matchesScope(await this.options.activeScope(), scope)) return
      const state = await readState(scope)
      const pending = new Set(state.pendingReceipts)
      const baselines = state.receiptBaselines ?? {}
      outcomes.push(...collectActivityReceiptNotifications(activity.items, baselines, pending))
      const key = notificationStateKey(scope)
      const successful = new Map(this.successfulReads.get(key))
      await chrome.storage.local.set({
        [key]: {
          ...state,
          receiptBaselines: { ...Object.fromEntries(successful), ...baselines },
          pendingReceipts: [...pending].slice(-MAX_PENDING_RECEIPTS)
        } satisfies NotificationState
      })
      const currentReads = this.successfulReads.get(key)
      for (const [source, readAt] of successful) {
        if (currentReads?.get(source) === readAt) currentReads.delete(source)
      }
      if (currentReads?.size === 0) this.successfulReads.delete(key)
      for (const outcome of outcomes) await this.post(scope, outcome).catch(() => {})
    })
  }

  async open(id: string): Promise<void> {
    if (!id.startsWith(NOTIFICATION_PREFIX)) return
    const scope = await this.options.activeScope().catch(() => null)
    let route = EXTENSION_ACTIVITY_ROUTE
    if (scope) {
      const delivery = (await readState(scope)).deliveries[id]
      if (delivery) {
        const activity = await this.options.readActivity(false, scope).catch(() => null)
        const item =
          activity && matchesScope({ ...activity.scope, network: DEFAULT_NETWORK }, scope)
            ? activity.items.find(item => item.id === delivery.itemId)
            : undefined
        if (matchesScope(await this.options.activeScope(), scope)) {
          const params = new URLSearchParams({ tab: 'activity', transactionId: delivery.itemId })
          const domain = (item ? getActivityBalanceDomains(item)[0] : undefined) ?? delivery.domain
          if (domain && domain !== 'public') params.set('domain', domain)
          route = `/?${params}`
        }
      }
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL(`${EXTENSION_POPUP_PATH}#${route}`) })
    await chrome.notifications.clear(id)
  }

  private enabledAt(): Promise<number> {
    this.epoch ??= (async () => {
      const stored = (await chrome.storage.local.get(TRACKING_EPOCH_KEY))[TRACKING_EPOCH_KEY]
      if (typeof stored === 'number' && Number.isFinite(stored)) return stored
      const now = Date.now()
      await chrome.storage.local.set({ [TRACKING_EPOCH_KEY]: now })
      return now
    })().catch(error => {
      this.epoch = undefined
      throw error
    })
    return this.epoch
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.tail.then(operation)
    this.tail = task.catch(() => {})
    return task
  }

  private deliver(scope: ScopedAccount, outcome: ActivityNotificationOutcome): Promise<void> {
    return this.enqueue(() => this.post(scope, outcome))
  }

  private async post(scope: ScopedAccount, outcome: ActivityNotificationOutcome): Promise<void> {
    if (scope.network !== DEFAULT_NETWORK) return
    const snapshot = await readActiveStorageV2Snapshot(new IndexedDbStorageV2Repository())
    if (
      !snapshot?.accounts.some(
        account => account.id === scope.accountId && account.keyDomainId === scope.keyDomainId
      )
    )
      return
    const key = notificationStateKey(scope)
    const id = await notificationId(
      JSON.stringify([key, activityNotificationKey(outcome), outcome.result])
    )
    const state = await readState(scope)
    if (state.deliveries[id]) return
    const domain = getActivityBalanceDomains(outcome.item)[0]
    const deliveries = Object.fromEntries([
      ...Object.entries(state.deliveries).slice(-(MAX_DELIVERIES_PER_ACCOUNT - 1)),
      [id, { itemId: outcome.item.id, ...(domain ? { domain } : {}) }]
    ])
    await chrome.storage.local.set({ [key]: { ...state, deliveries } satisfies NotificationState })
    try {
      const copy = await this.copy(scope, outcome).catch(() => PRIVATE_ACTIVITY_NOTIFICATION)
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        ...copy
      })
    } catch (error) {
      await chrome.storage.local.set({ [key]: state })
      throw error
    }
  }

  private async copy(scope: ScopedAccount, outcome: ActivityNotificationOutcome) {
    const active = await this.options.activeScope()
    const settings = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY]
    const decoded = decodePersistedWalletSettings(settings)
    if (
      !matchesScope(active, scope) ||
      (settings !== undefined && (!decoded || decoded.balancesHidden === true)) ||
      !(await this.options.hasUnlockSession())
    ) {
      return PRIVATE_ACTIVITY_NOTIFICATION
    }
    const custom = resolveEvmNetworkCatalog(scope.network, getActiveChainEndpointSettings()).filter(
      chain => chain.source === 'custom'
    )
    const chains = createInitialProductChainRegistry(scope.network, custom)
    const assets = createAssetRegistry(
      chains,
      getBundledInitialProductAssetDefinitions(scope.network, custom)
    )
    return formatActivityNotification(outcome, {
      asset: assetId => this.options.assetMetadata(assetId) ?? assets.get(assetId)?.metadata,
      chain: chainId => chains.get(chainId)?.displayName
    })
  }
}
