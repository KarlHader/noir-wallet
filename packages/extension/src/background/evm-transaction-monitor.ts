import { getEvmNetworkConfigs, type EvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { listKeySourceAllowedAccountScopes } from '@/core/accounts/application'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import { DedupPromise } from '@/lib/async-utils'
import {
  createConfiguredEvmActivityHistorySource,
  createConfiguredEvmRpcClient,
  EvmTransactionMonitor,
  type EvmTransactionMonitorResult
} from '@/infrastructure/chains/evm'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'

export const EVM_TRANSACTION_MONITOR_ALARM = 'evm-transaction-monitor-alarm'
const POLL_DELAY_MINUTES = 0.5
const MAXIMUM_FAILURE_DELAY_MINUTES = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseScopes(value: unknown): readonly TransactionAccountScope[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Invalid EVM monitor Account scopes')
  }
  return Object.freeze(
    value.map(scope => {
      if (
        !isRecord(scope) ||
        Object.keys(scope).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(scope, 'keyDomainId') ||
        !Object.prototype.hasOwnProperty.call(scope, 'accountId')
      ) {
        throw new Error('Invalid EVM monitor Account scope')
      }
      return Object.freeze({
        keyDomainId: parseKeyDomainId(scope.keyDomainId),
        accountId: parseAccountId(scope.accountId)
      })
    })
  )
}

export class BackgroundEvmTransactionMonitor {
  private readonly storageRepository = new IndexedDbStorageV2Repository()
  private consecutiveFailurePolls = 0
  private nextPollAt = 0
  private readonly pollDedup = new DedupPromise<EvmTransactionMonitorResult>()
  private readonly monitors: readonly Readonly<{
    network: EvmNetworkConfig
    monitor: EvmTransactionMonitor
  }>[]

  constructor(networks: readonly EvmNetworkConfig[] = getEvmNetworkConfigs(DEFAULT_NETWORK)) {
    this.monitors = Object.freeze(
      networks.map(network => {
        const replacementSource = createConfiguredEvmActivityHistorySource(DEFAULT_NETWORK, network)
        return Object.freeze({
          network,
          monitor: new EvmTransactionMonitor({
            repository: new IndexedDbTransactionRepository(),
            chainId: network.chainId,
            rpc: createConfiguredEvmRpcClient(DEFAULT_NETWORK, network),
            ...(network.chainId === 'eip155:1' ? { concurrency: 2 } : {}),
            ...(replacementSource === undefined ? {} : { replacementSource })
          })
        })
      })
    )
  }

  async init(): Promise<EvmTransactionMonitorResult> {
    return this.pollDedup.run(() => this.pollPersisted())
  }

  async handleAlarm(): Promise<EvmTransactionMonitorResult> {
    return this.pollDedup.run(async () => {
      const remainingMs = this.nextPollAt - Date.now()
      if (remainingMs > 1_000) {
        await chrome.alarms.create(EVM_TRANSACTION_MONITOR_ALARM, {
          delayInMinutes: remainingMs / 60_000
        })
        return Object.freeze({ checked: 0, applied: 0, unchanged: 0, errors: 0 })
      }
      return this.pollPersisted()
    })
  }

  async pollConformanceScopes(value: unknown): Promise<EvmTransactionMonitorResult> {
    if (!__MULTICHAIN_CONFORMANCE_RPC_ENABLED__) {
      throw new Error('EVM monitor conformance route is unavailable')
    }
    const scopes = parseScopes(value)
    return this.poll(this.monitors.map(entry => Object.freeze({ ...entry, scopes })))
  }

  private async loadPersistedScopes(chainId: string): Promise<readonly TransactionAccountScope[]> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze([])
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    return listKeySourceAllowedAccountScopes({
      keyDomains: snapshot.keyDomains,
      chainAccounts: snapshot.chainAccounts,
      chainId,
      family: 'evm'
    })
  }

  private async pollPersisted(): Promise<EvmTransactionMonitorResult> {
    return this.poll(
      await Promise.all(
        this.monitors.map(async entry =>
          Object.freeze({
            ...entry,
            scopes: await this.loadPersistedScopes(entry.network.chainId)
          })
        )
      )
    )
  }

  private async poll(
    entries: readonly Readonly<{
      monitor: EvmTransactionMonitor
      scopes: readonly TransactionAccountScope[]
    }>[]
  ): Promise<EvmTransactionMonitorResult> {
    const results = await Promise.all(entries.map(entry => entry.monitor.poll(entry.scopes)))
    const result = Object.freeze({
      checked: results.reduce((sum, item) => sum + item.checked, 0),
      applied: results.reduce((sum, item) => sum + item.applied, 0),
      unchanged: results.reduce((sum, item) => sum + item.unchanged, 0),
      errors: results.reduce((sum, item) => sum + item.errors, 0)
    })
    if (result.errors > 0) {
      console.warn(`[EVM Transaction Monitor] ${result.errors} observation(s) failed`)
    }
    this.consecutiveFailurePolls = result.errors > 0 ? this.consecutiveFailurePolls + 1 : 0
    if (result.checked > 0 || result.errors > 0) {
      const delayInMinutes =
        result.errors > 0
          ? Math.min(
              POLL_DELAY_MINUTES * 2 ** this.consecutiveFailurePolls,
              MAXIMUM_FAILURE_DELAY_MINUTES
            )
          : POLL_DELAY_MINUTES
      this.nextPollAt = Date.now() + delayInMinutes * 60_000
      await chrome.alarms.create(EVM_TRANSACTION_MONITOR_ALARM, {
        delayInMinutes
      })
    } else {
      this.nextPollAt = 0
      await chrome.alarms.clear(EVM_TRANSACTION_MONITOR_ALARM)
    }
    return result
  }
}
