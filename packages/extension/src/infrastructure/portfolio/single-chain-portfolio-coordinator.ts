import { loadActiveReceiveWalletSet } from '@/core/accounts/application'
import type { ChainAccount } from '@/core/accounts/domain'
import type { AddressGatedChainRegistry, AssetRegistry } from '@/core/chains/registry'
import {
  buildPortfolioReadModel,
  type PortfolioReadModel,
  type PortfolioSourceSnapshot
} from '@/core/portfolio'
import { DedupPromise } from '@/lib/async-utils'
import type {
  PortfolioCacheRepository,
  StorageV2GenerationId,
  StorageV2ReadRepository
} from '@/ports/repositories'

type SingleChainPortfolioStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export type AddressOnlyPortfolioFamily = 'solana' | 'near'

export interface ActiveSingleChainPortfolioSource {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly source: PortfolioSourceSnapshot
}

export interface ReadSingleChainPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly now: () => number
}

export interface SingleChainPortfolioCoordinatorOptions {
  readonly storageRepository: SingleChainPortfolioStorageRepository
  readonly cacheRepository: PortfolioCacheRepository
  readonly chains: AddressGatedChainRegistry
  readonly assets: AssetRegistry
  readonly chainId: string
  readonly family: AddressOnlyPortfolioFamily
  readonly isNetworkEnabled?: (
    scope: {
      readonly keyDomainId: ChainAccount['scope']['keyDomainId']
      readonly accountId: ChainAccount['scope']['accountId']
    },
    family: AddressOnlyPortfolioFamily,
    chainId: string
  ) => boolean | Promise<boolean>
  readonly readSource: (
    input: ReadSingleChainPortfolioSourceInput
  ) => Promise<PortfolioSourceSnapshot>
  readonly now?: () => number
}

function chainAccountsEqual(left: ChainAccount, right: ChainAccount): boolean {
  return (
    left.id === right.id &&
    left.scope.keyDomainId === right.scope.keyDomainId &&
    left.scope.accountId === right.scope.accountId &&
    left.scope.chainId === right.scope.chainId &&
    left.derivation.scheme === right.derivation.scheme &&
    left.derivation.path === right.derivation.path &&
    left.identity.kind === right.identity.kind &&
    left.identity.value === right.identity.value &&
    left.createdAt === right.createdAt
  )
}

function preserveCachedBalances(
  refreshed: PortfolioSourceSnapshot,
  cached: PortfolioSourceSnapshot | undefined
): PortfolioSourceSnapshot {
  if (refreshed.status !== 'error' || !cached) return refreshed
  const refreshedAssetIds = new Set(refreshed.balances.map(balance => balance.assetId))
  const cachedFallbacks = cached.balances.filter(balance => !refreshedAssetIds.has(balance.assetId))
  if (cachedFallbacks.length === 0) return refreshed
  return Object.freeze({
    ...refreshed,
    balances: Object.freeze([...refreshed.balances, ...cachedFallbacks])
  })
}

export class SingleChainPortfolioCoordinator {
  private readonly options: SingleChainPortfolioCoordinatorOptions
  private readonly refreshes = new Map<
    string,
    DedupPromise<ActiveSingleChainPortfolioSource | null>
  >()

  constructor(options: SingleChainPortfolioCoordinatorOptions) {
    const chain = options.chains.resolve(options.chainId)
    if (chain.family !== options.family) {
      throw new Error('Single-chain Portfolio coordinator family does not match its chain')
    }
    if (options.assets.list(chain.id).length === 0) {
      throw new Error('Single-chain Portfolio coordinator requires a bundled asset inventory')
    }
    this.options = { ...options, chainId: chain.id }
  }

  async readCachedActive(): Promise<PortfolioReadModel | null> {
    const active = await this.readCachedActiveSource()
    return active ? this.buildReadModel(active) : null
  }

  async readCachedActiveSource(): Promise<ActiveSingleChainPortfolioSource | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const cached = await this.options.cacheRepository.get(
      context.generationId,
      context.chainAccount.id
    )
    if (cached && !chainAccountsEqual(cached.source.chainAccount, context.chainAccount)) {
      throw new Error('Portfolio cache ChainAccount does not match active Storage V2 metadata')
    }
    const source = cached
      ? cached.source
      : Object.freeze({
          chainAccount: context.chainAccount,
          status: 'loading' as const,
          balances: Object.freeze([])
        })
    return Object.freeze({ ...context, source })
  }

  async refreshActive(): Promise<PortfolioReadModel | null> {
    const active = await this.refreshActiveSource()
    return active ? this.buildReadModel(active) : null
  }

  async refreshActiveSource(): Promise<ActiveSingleChainPortfolioSource | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const key = JSON.stringify([context.generationId, context.chainAccount.id])
    const gate =
      this.refreshes.get(key) ?? new DedupPromise<ActiveSingleChainPortfolioSource | null>()
    this.refreshes.set(key, gate)
    return gate
      .run(() => this.refresh(context))
      .finally(() => {
        if (!gate.isPending) this.refreshes.delete(key)
      })
  }

  private async loadActiveContext(): Promise<Omit<
    ActiveSingleChainPortfolioSource,
    'source'
  > | null> {
    const active = await loadActiveReceiveWalletSet({
      repository: this.options.storageRepository,
      chainRegistry: this.options.chains
    })
    if (!active?.activeAccount) return null
    const selectedAccount = active.activeAccount
    const candidates = active.availableChainAccounts.filter(
      candidate => candidate.chain.id === this.options.chainId
    )
    if (candidates.length === 0) return null
    if (
      active.catalog.keyDomains.find(item => item.id === selectedAccount.keyDomainId)?.source
        .kind === 'software' &&
      this.options.isNetworkEnabled &&
      !(await this.options.isNetworkEnabled(
        { keyDomainId: selectedAccount.keyDomainId, accountId: selectedAccount.id },
        this.options.family,
        this.options.chainId
      ))
    ) {
      return null
    }
    if (candidates.length !== 1) {
      throw new Error('Active Account has ambiguous single-chain Portfolio metadata')
    }
    return Object.freeze({
      generationId: active.generationId,
      chainAccount: candidates[0].chainAccount
    })
  }

  private buildReadModel(active: ActiveSingleChainPortfolioSource): PortfolioReadModel {
    return buildPortfolioReadModel(
      {
        keyDomainId: active.chainAccount.scope.keyDomainId,
        accountId: active.chainAccount.scope.accountId
      },
      [active.source],
      this.options.chains,
      this.options.assets
    )
  }

  private async refresh(
    context: Omit<ActiveSingleChainPortfolioSource, 'source'>
  ): Promise<ActiveSingleChainPortfolioSource | null> {
    const refreshedAt = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(refreshedAt) || refreshedAt < 0) {
      throw new Error('Invalid single-chain Portfolio refresh timestamp')
    }
    const refreshedSource = await this.options.readSource({
      chainAccount: context.chainAccount,
      assets: this.options.assets,
      now: () => refreshedAt
    })
    if (!chainAccountsEqual(refreshedSource.chainAccount, context.chainAccount)) {
      throw new Error('Refreshed Portfolio source does not match the active ChainAccount')
    }
    const cached =
      refreshedSource.status === 'error'
        ? await this.options.cacheRepository.get(context.generationId, context.chainAccount.id)
        : null
    if (cached && !chainAccountsEqual(cached.source.chainAccount, context.chainAccount)) {
      throw new Error('Portfolio cache ChainAccount does not match active Storage V2 metadata')
    }
    const source = preserveCachedBalances(refreshedSource, cached?.source)
    await this.options.cacheRepository.put({
      generationId: context.generationId,
      cachedAt: refreshedAt,
      source
    })
    const currentPointer = await this.options.storageRepository.getActivePointer()
    if (currentPointer?.generationId !== context.generationId) return null
    return Object.freeze({ ...context, source })
  }
}
