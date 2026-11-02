import type { ChainAccount } from '@/core/accounts/domain'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { AssetRegistry, ChainRegistry } from '@/core/chains/registry'
import type { KeyDomainSource } from '@/core/keyring/domain'
import { parseChainId } from '@/core/chains/registry'
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
import { readEvmPortfolioSource } from './evm-balance-reader'
import type { EvmBalanceRpc } from './evm-rpc-client'

export type EvmPortfolioStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export interface EvmPortfolioCoordinatorOptions {
  readonly storageRepository: EvmPortfolioStorageRepository
  readonly cacheRepository: PortfolioCacheRepository
  readonly chainId: string
  readonly chains: ChainRegistry
  readonly assets: AssetRegistry
  readonly rpc: EvmBalanceRpc
  readonly resolvePrivateExecutionAddress?: (
    context: ActiveEvmPortfolioContext
  ) => Promise<string | null>
  readonly now?: () => number
}

export interface ActiveEvmPortfolioContext {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly keyDomainSource: KeyDomainSource
}

export interface ActiveEvmPortfolioSource extends ActiveEvmPortfolioContext {
  readonly source: PortfolioSourceSnapshot
}

export async function loadActiveEvmPortfolioContext(
  storageRepository: EvmPortfolioStorageRepository,
  chainIdValue: string
): Promise<ActiveEvmPortfolioContext | null> {
  const chainId = parseChainId(chainIdValue).id
  if (!chainId.startsWith('eip155:')) {
    throw new Error('Active EVM context requires an EVM chain ID')
  }
  const pointer = await storageRepository.getActivePointer()
  if (!pointer) return null
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
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
  const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
  if (!keySourceSupportsChainFamily(keyDomain.source, 'evm')) return null
  const candidates = snapshot.chainAccounts.filter(
    chainAccount =>
      chainAccount.scope.keyDomainId === active.keyDomainId &&
      chainAccount.scope.accountId === active.accountId &&
      chainAccount.scope.chainId === chainId
  )
  if (candidates.length === 0) return null
  if (candidates.length !== 1) throw new Error('Active Account has ambiguous EVM ChainAccounts')
  return Object.freeze({
    generationId: pointer.generationId,
    chainAccount: candidates[0],
    keyDomainSource: keyDomain.source
  })
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

export class EvmPortfolioCoordinator {
  private readonly options: EvmPortfolioCoordinatorOptions
  private readonly refreshes = new Map<string, DedupPromise<ActiveEvmPortfolioSource | null>>()

  constructor(options: EvmPortfolioCoordinatorOptions) {
    const chain = options.chains.resolve(options.chainId)
    if (chain.family !== 'evm') throw new Error('EVM Portfolio coordinator requires an EVM chain')
    if (options.assets.list(chain.id).length === 0) {
      throw new Error('EVM Portfolio coordinator requires a bundled asset inventory')
    }
    this.options = { ...options, chainId: chain.id }
  }

  async readCachedActive(): Promise<PortfolioReadModel | null> {
    const active = await this.readCachedActiveSource()
    return active ? this.buildReadModel(active) : null
  }

  async readCachedActiveSource(): Promise<ActiveEvmPortfolioSource | null> {
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
      ? this.requiresPrivateBalanceRefresh(context, cached.source)
        ? {
            ...cached.source,
            status: cached.source.status === 'ready' ? ('loading' as const) : cached.source.status,
            balances: Object.freeze([])
          }
        : cached.source
      : {
          chainAccount: context.chainAccount,
          status: 'loading' as const,
          balances: Object.freeze([])
        }
    return Object.freeze({ ...context, source })
  }

  async refreshActive(): Promise<PortfolioReadModel | null> {
    const active = await this.refreshActiveSource()
    return active ? this.buildReadModel(active) : null
  }

  async refreshActiveSource(): Promise<ActiveEvmPortfolioSource | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const key = JSON.stringify([context.generationId, context.chainAccount.id])
    const gate = this.refreshes.get(key) ?? new DedupPromise<ActiveEvmPortfolioSource | null>()
    this.refreshes.set(key, gate)
    return gate
      .run(() => this.refresh(context))
      .finally(() => {
        if (!gate.isPending) this.refreshes.delete(key)
      })
  }

  private async loadActiveContext(): Promise<ActiveEvmPortfolioContext | null> {
    return loadActiveEvmPortfolioContext(this.options.storageRepository, this.options.chainId)
  }

  private buildReadModel(active: ActiveEvmPortfolioSource): PortfolioReadModel {
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
    context: ActiveEvmPortfolioContext
  ): Promise<ActiveEvmPortfolioSource | null> {
    const refreshedAt = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(refreshedAt) || refreshedAt < 0) {
      throw new Error('Invalid EVM Portfolio refresh timestamp')
    }
    const privateAddress =
      supportsEvmPrivateExecution(context.keyDomainSource) &&
      this.options.resolvePrivateExecutionAddress
        ? await this.options.resolvePrivateExecutionAddress(context)
        : undefined
    const refreshedSource =
      privateAddress === null
        ? Object.freeze({
            chainAccount: context.chainAccount,
            status: 'error' as const,
            balances: Object.freeze([]),
            errorCode: 'unknown' as const
          })
        : await readEvmPortfolioSource({
            chainId: context.chainAccount.scope.chainId,
            chainAccount: context.chainAccount,
            assets: this.options.assets,
            rpc: this.options.rpc,
            ...(privateAddress === undefined ? {} : { privateAddress }),
            now: () => refreshedAt
          })
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

  private requiresPrivateBalanceRefresh(
    context: ActiveEvmPortfolioContext,
    source: PortfolioSourceSnapshot
  ): boolean {
    return (
      supportsEvmPrivateExecution(context.keyDomainSource) &&
      this.options.resolvePrivateExecutionAddress !== undefined &&
      source.balances.some(
        balance => balance.mainRaw === undefined || balance.privateRaw === undefined
      )
    )
  }
}
