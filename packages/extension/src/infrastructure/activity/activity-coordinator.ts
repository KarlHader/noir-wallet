import {
  buildActivityReadModel,
  type ActivityItem,
  type ActivityReadModel,
  type ActivityScope
} from '@/core/activity'
import type { TransactionGraph } from '@/core/transactions/domain'
import type { Transaction } from '@/types'
import type { StorageV2ReadRepository, TransactionRepository } from '@/ports/repositories'
import { mapZcashV1TransactionToActivityItem } from './zcash-v1-activity-source'

type ActivityStorageRepository = Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>

export interface ActivityCoordinatorOptions {
  readonly storageRepository: ActivityStorageRepository
  readonly transactionRepository: TransactionRepository
  readonly loadZcashTransactions: (scope: ActivityScope) => Promise<readonly Transaction[]>
  readonly loadSupplementalItems?: (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all',
    chainIds?: readonly string[],
    historyPageCount?: number
  ) => Promise<readonly ActivityItem[]>
  readonly loadSupplementalHasMore?: (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all',
    chainIds?: readonly string[]
  ) => Promise<boolean>
  readonly loadCachedSupplementalItems?: (
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all'
  ) => Promise<readonly ActivityItem[]>
  readonly loadPrivateExecutionAddresses?: (
    scope: ActivityScope,
    localGraphs: readonly TransactionGraph[]
  ) => Promise<readonly string[]>
  readonly filterLocalGraphs?: (
    scope: ActivityScope,
    graphs: readonly TransactionGraph[]
  ) => Promise<readonly TransactionGraph[]>
}

export interface ActivityReadOptions {
  readonly includeSupplemental?: boolean
  readonly accountMode?: 'main' | 'private' | 'all'
  readonly chainIds?: readonly string[]
  readonly historyPageCount?: number
}

export class ActivityCoordinator {
  constructor(private readonly options: ActivityCoordinatorOptions) {}

  async readActive(options: ActivityReadOptions = {}): Promise<ActivityReadModel | null> {
    const scope = await this.loadActiveScope()
    if (!scope) return null
    const accountMode = options.accountMode ?? 'main'
    const [storedLocalGraphs, zcashTransactions, supplementalItems] = await Promise.all([
      this.options.transactionRepository.list({ scope, limit: 200 }),
      this.options.loadZcashTransactions(scope),
      this.loadSupplementalItems(scope, accountMode, options)
    ])
    const localGraphs = this.options.filterLocalGraphs
      ? await this.options.filterLocalGraphs(scope, storedLocalGraphs)
      : storedLocalGraphs
    const privateExecutionAddresses = await this.loadPrivateExecutionAddresses(scope, localGraphs)
    const destinationReceipts = new Map<string, Transaction[]>()
    for (const transaction of zcashTransactions) {
      if (transaction.type !== 'receive' || !transaction.txHash) continue
      const hash = transaction.txHash.toLowerCase()
      destinationReceipts.set(hash, [...(destinationReceipts.get(hash) ?? []), transaction])
    }
    const hasMore = await this.options
      .loadSupplementalHasMore?.(scope, accountMode, options.chainIds)
      .catch(() => false)
    return buildActivityReadModel({
      scope,
      localGraphs,
      supplementalItems: Object.freeze([
        ...zcashTransactions.map(transaction => {
          const matchingReceipts = destinationReceipts
            .get(transaction.destinationTxHash?.toLowerCase() ?? '')
            ?.filter(
              receipt =>
                receipt.network === transaction.network &&
                receipt.fromType === 'transparent' &&
                receipt.to === transaction.quoteBinding?.recipient &&
                (receipt.confirmations ?? 0) > 0
            )
          return mapZcashV1TransactionToActivityItem(
            transaction,
            scope,
            matchingReceipts?.length === 1 ? matchingReceipts[0] : undefined
          )
        }),
        ...supplementalItems
      ]),
      privateExecutionAddresses,
      limit: 2_000,
      hasMore
    })
  }

  private async loadSupplementalItems(
    scope: ActivityScope,
    accountMode: 'main' | 'private' | 'all',
    options: ActivityReadOptions
  ): Promise<readonly ActivityItem[]> {
    if (options.includeSupplemental !== false && this.options.loadSupplementalItems) {
      try {
        return await this.options.loadSupplementalItems(
          scope,
          accountMode,
          options.chainIds,
          options.historyPageCount
        )
      } catch (error) {
        if ((options.historyPageCount ?? 1) > 1) throw error
        console.warn(
          '[Activity] Supplemental refresh failed:',
          error instanceof Error ? error.name : 'UnknownError'
        )
      }
    }
    try {
      return (await this.options.loadCachedSupplementalItems?.(scope, accountMode)) ?? []
    } catch (error) {
      console.warn(
        '[Activity] Supplemental cache read failed:',
        error instanceof Error ? error.name : 'UnknownError'
      )
      return []
    }
  }

  private async loadPrivateExecutionAddresses(
    scope: ActivityScope,
    localGraphs: readonly TransactionGraph[]
  ): Promise<readonly string[]> {
    try {
      return (await this.options.loadPrivateExecutionAddresses?.(scope, localGraphs)) ?? []
    } catch (error) {
      // Optional address classification must not prevent reading persisted transactions.
      console.warn(
        '[Activity] Private address lookup failed:',
        error instanceof Error ? error.name : 'UnknownError'
      )
      return []
    }
  }

  private async loadActiveScope(): Promise<ActivityScope | null> {
    const pointer = await this.options.storageRepository.getActivePointer()
    if (!pointer) return null
    const snapshot = await this.options.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }
    const active = snapshot.manifest.activeAccount
    if (!active) return null
    return Object.freeze({
      keyDomainId: active.keyDomainId,
      accountId: active.accountId
    })
  }
}
