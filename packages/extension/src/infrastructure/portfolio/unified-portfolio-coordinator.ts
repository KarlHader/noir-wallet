import { loadActiveReceiveWalletSet } from '@/core/accounts/application/active-wallet-set'
import type { AccountId } from '@/core/accounts/domain'
import type { AddressGatedChainRegistry, AssetRegistry } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  buildPortfolioReadModel,
  type PortfolioReadErrorCode,
  type PortfolioReadModel,
  type PortfolioSourceSnapshot,
  type PortfolioSourceStatus
} from '@/core/portfolio'
import type { ActiveEvmPortfolioSource } from '@/infrastructure/chains/evm'
import type { ActiveBitcoinPortfolioSource } from '@/infrastructure/chains/bitcoin'
import type { ActivePearlPortfolioSource } from '@/infrastructure/chains/pearl'
import type { ActiveDashPortfolioSource } from '@/infrastructure/chains/dash'
import type { ActiveSingleChainPortfolioSource } from './single-chain-portfolio-coordinator'
import { readZcashPortfolioSource } from '@/infrastructure/chains/zcash'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import type { ZcashBalance } from '@/types'

type UnifiedPortfolioStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

const EVM_PORTFOLIO_SOURCE_CONCURRENCY = 8

export interface ZcashPortfolioRuntimeState {
  readonly balance: ZcashBalance | null
  readonly status: PortfolioSourceStatus
  readonly updatedAt: number
  readonly errorCode?: PortfolioReadErrorCode
}

export interface EvmPortfolioSourceReader {
  readonly readCachedActiveSource: () => Promise<ActiveEvmPortfolioSource | null>
  readonly refreshActiveSource: () => Promise<ActiveEvmPortfolioSource | null>
}

export interface EvmPortfolioSourceRegistration {
  readonly chainId: string
  readonly portfolio: EvmPortfolioSourceReader
}

export interface BitcoinPortfolioSourceReader {
  readonly readCachedActiveSource: () => Promise<ActiveBitcoinPortfolioSource | null>
  readonly refreshActiveSource: () => Promise<ActiveBitcoinPortfolioSource | null>
}

export interface PearlPortfolioSourceReader {
  readonly readCachedActiveSource: () => Promise<ActivePearlPortfolioSource | null>
  readonly refreshActiveSource: () => Promise<ActivePearlPortfolioSource | null>
}

export interface DashPortfolioSourceReader {
  readonly readCachedActiveSource: () => Promise<ActiveDashPortfolioSource | null>
  readonly refreshActiveSource: () => Promise<ActiveDashPortfolioSource | null>
}

export interface SingleChainPortfolioSourceReader {
  readonly readCachedActiveSource: () => Promise<ActiveSingleChainPortfolioSource | null>
  readonly refreshActiveSource: () => Promise<ActiveSingleChainPortfolioSource | null>
}

export interface UnifiedPortfolioCoordinatorOptions {
  readonly storageRepository: UnifiedPortfolioStorageRepository
  readonly chains: AddressGatedChainRegistry
  readonly assets: AssetRegistry
  readonly evmPortfolios?: readonly EvmPortfolioSourceRegistration[]
  readonly bitcoinPortfolio?: BitcoinPortfolioSourceReader
  readonly pearlPortfolio?: PearlPortfolioSourceReader
  readonly dashPortfolio?: DashPortfolioSourceReader
  readonly solanaPortfolio?: SingleChainPortfolioSourceReader
  readonly nearPortfolio?: SingleChainPortfolioSourceReader
  readonly quantusPortfolio?: SingleChainPortfolioSourceReader
  readonly starknetPortfolio?: SingleChainPortfolioSourceReader
  readonly onBackgroundBitcoinRefreshError?: (error: unknown) => void
  readonly onBackgroundBitcoinRefreshSettled?: (source: ActiveBitcoinPortfolioSource | null) => void
  readonly onBackgroundPearlRefreshError?: (error: unknown) => void
  readonly onBackgroundPearlRefreshSettled?: (source: ActivePearlPortfolioSource | null) => void
  readonly onBackgroundDashRefreshError?: (error: unknown) => void
  readonly onBackgroundDashRefreshSettled?: (source: ActiveDashPortfolioSource | null) => void
  readonly readZcashState: (scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }) => ZcashPortfolioRuntimeState
}

export const PORTFOLIO_COORDINATOR_STAGES = Object.freeze([
  'active-wallet',
  'zcash-source',
  'evm-source',
  'bitcoin-source',
  'dash-source',
  'pearl-source',
  'solana-source',
  'near-source',
  'quantus-source',
  'starknet-source',
  'read-model'
] as const)

export type PortfolioCoordinatorStage = (typeof PORTFOLIO_COORDINATOR_STAGES)[number]

interface SingleChainPortfolioSourceDefinition {
  readonly family: 'solana' | 'near' | 'quantus'
  readonly label: string
  readonly stage: 'solana-source' | 'near-source' | 'quantus-source'
  readonly read: (
    options: UnifiedPortfolioCoordinatorOptions
  ) => SingleChainPortfolioSourceReader | undefined
}

const SINGLE_CHAIN_PORTFOLIO_SOURCES: readonly SingleChainPortfolioSourceDefinition[] =
  Object.freeze([
    {
      family: 'solana',
      label: 'Solana',
      stage: 'solana-source',
      read: options => options.solanaPortfolio
    },
    {
      family: 'near',
      label: 'NEAR',
      stage: 'near-source',
      read: options => options.nearPortfolio
    },
    {
      family: 'quantus',
      label: 'Quantus',
      stage: 'quantus-source',
      read: options => options.quantusPortfolio
    }
  ])

export class PortfolioCoordinatorError extends Error {
  readonly stage: PortfolioCoordinatorStage
  readonly cause: unknown

  constructor(stage: PortfolioCoordinatorStage, cause: unknown) {
    super(`Portfolio ${stage} operation failed`)
    this.name = 'PortfolioCoordinatorError'
    this.stage = stage
    this.cause = cause
  }
}

async function atStage<T>(
  stage: PortfolioCoordinatorStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof PortfolioCoordinatorError) throw error
    throw new PortfolioCoordinatorError(stage, error)
  }
}

function atSynchronousStage<T>(stage: PortfolioCoordinatorStage, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof PortfolioCoordinatorError) throw error
    throw new PortfolioCoordinatorError(stage, error)
  }
}

function sameActiveScope(
  source:
    | ActiveEvmPortfolioSource
    | ActiveBitcoinPortfolioSource
    | ActivePearlPortfolioSource
    | ActiveDashPortfolioSource
    | ActiveSingleChainPortfolioSource,
  generationId: StorageV2GenerationId,
  keyDomainId: KeyDomainId,
  accountId: AccountId
): boolean {
  return (
    source.generationId === generationId &&
    source.chainAccount.scope.keyDomainId === keyDomainId &&
    source.chainAccount.scope.accountId === accountId
  )
}

function sourceUpdatedAt(
  source: ActiveBitcoinPortfolioSource | ActivePearlPortfolioSource | ActiveDashPortfolioSource
): number {
  return source.source.balances.reduce((latest, balance) => Math.max(latest, balance.updatedAt), 0)
}

function uncachedSource(
  chainAccount: PortfolioSourceSnapshot['chainAccount']
): PortfolioSourceSnapshot {
  return Object.freeze({ chainAccount, status: 'loading', balances: Object.freeze([]) })
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results: R[] = new Array(values.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return Object.freeze(results)
}

export class UnifiedPortfolioCoordinator {
  private readonly options: UnifiedPortfolioCoordinatorOptions
  private backgroundBitcoinSource: ActiveBitcoinPortfolioSource | null = null
  private backgroundPearlSource: ActivePearlPortfolioSource | null = null
  private backgroundDashSource: ActiveDashPortfolioSource | null = null

  constructor(options: UnifiedPortfolioCoordinatorOptions) {
    this.options = options
  }

  readCachedActive(): Promise<PortfolioReadModel | null> {
    return this.readActive('read')
  }

  refreshActive(chainIds?: readonly string[]): Promise<PortfolioReadModel | null> {
    return this.readActive('refresh', chainIds)
  }

  private async readActive(
    action: 'read' | 'refresh',
    chainIds?: readonly string[]
  ): Promise<PortfolioReadModel | null> {
    const active = await atStage('active-wallet', () =>
      loadActiveReceiveWalletSet({
        repository: this.options.storageRepository,
        chainRegistry: this.options.chains
      })
    )
    if (!active?.activeAccount) return null

    const scope = Object.freeze({
      keyDomainId: active.activeAccount.keyDomainId,
      accountId: active.activeAccount.id
    })
    const refreshChainIds = chainIds ? new Set(chainIds) : null
    const shouldRefreshChain = (chainId: string) =>
      action === 'refresh' && (refreshChainIds === null || refreshChainIds.has(chainId))
    const sources: PortfolioSourceSnapshot[] = []
    const zcashAccount = active.availableChainAccounts.find(item => item.chain.family === 'zcash')
    if (zcashAccount) {
      sources.push(
        atSynchronousStage('zcash-source', () => {
          const state = this.options.readZcashState(scope)
          return readZcashPortfolioSource({
            chainId: zcashAccount.chain.id,
            chainAccount: zcashAccount.chainAccount,
            chains: this.options.chains,
            assets: this.options.assets,
            ...state
          })
        })
      )
    }

    const evmAccounts = active.availableChainAccounts.filter(item => item.chain.family === 'evm')
    if (evmAccounts.length > 0) {
      const registrations = new Map<string, EvmPortfolioSourceReader>()
      for (const registration of this.options.evmPortfolios ?? []) {
        if (registrations.has(registration.chainId)) {
          throw new Error('Enabled EVM Portfolio source is duplicated')
        }
        registrations.set(registration.chainId, registration.portfolio)
      }
      const evmSources = await atStage('evm-source', () =>
        mapWithConcurrency(evmAccounts, EVM_PORTFOLIO_SOURCE_CONCURRENCY, async evmAccount => {
          const evmPortfolio = registrations.get(evmAccount.chain.id)
          if (!evmPortfolio) throw new Error('Enabled EVM Portfolio source is unavailable')
          const source = shouldRefreshChain(evmAccount.chain.id)
            ? await evmPortfolio.refreshActiveSource()
            : await evmPortfolio.readCachedActiveSource()
          return Object.freeze({ evmAccount, source })
        })
      )
      for (const { evmAccount, source } of evmSources) {
        if (!source) {
          if (action !== 'read') return null
          sources.push(uncachedSource(evmAccount.chainAccount))
          continue
        }
        if (!sameActiveScope(source, active.generationId, scope.keyDomainId, scope.accountId)) {
          return null
        }
        if (source.chainAccount.id !== evmAccount.chainAccount.id) {
          throw new Error('EVM Portfolio source does not match the active ChainAccount')
        }
        sources.push(source.source)
      }
    }

    const bitcoinAccount = active.availableChainAccounts.find(
      item => item.chain.family === 'bitcoin'
    )
    if (bitcoinAccount) {
      const bitcoinPortfolio = this.options.bitcoinPortfolio
      if (!bitcoinPortfolio) {
        throw new Error('Enabled Bitcoin Portfolio source is unavailable')
      }
      const bitcoinSource = await atStage('bitcoin-source', () =>
        shouldRefreshChain(bitcoinAccount.chain.id)
          ? this.refreshBitcoinInBackground(bitcoinPortfolio)
          : this.readBitcoinSource(bitcoinPortfolio)
      )
      if (!bitcoinSource) {
        if (action !== 'read') return null
        sources.push(uncachedSource(bitcoinAccount.chainAccount))
      } else {
        if (
          !sameActiveScope(bitcoinSource, active.generationId, scope.keyDomainId, scope.accountId)
        ) {
          return null
        }
        if (bitcoinSource.chainAccount.id !== bitcoinAccount.chainAccount.id) {
          throw new Error('Bitcoin Portfolio source does not match the active ChainAccount')
        }
        sources.push(bitcoinSource.source)
      }
    }

    const pearlAccount = active.availableChainAccounts.find(item => item.chain.family === 'pearl')
    if (pearlAccount) {
      const pearlPortfolio = this.options.pearlPortfolio
      if (!pearlPortfolio) {
        throw new Error('Enabled Pearl Portfolio source is unavailable')
      }
      const pearlSource = await atStage('pearl-source', () =>
        shouldRefreshChain(pearlAccount.chain.id)
          ? this.refreshPearlInBackground(pearlPortfolio)
          : this.readPearlSource(pearlPortfolio)
      )
      if (!pearlSource) {
        if (action !== 'read') return null
        sources.push(uncachedSource(pearlAccount.chainAccount))
      } else {
        if (
          !sameActiveScope(pearlSource, active.generationId, scope.keyDomainId, scope.accountId)
        ) {
          return null
        }
        if (pearlSource.chainAccount.id !== pearlAccount.chainAccount.id) {
          throw new Error('Pearl Portfolio source does not match the active ChainAccount')
        }
        sources.push(pearlSource.source)
      }
    }

    const singleChainSources = await Promise.all(
      SINGLE_CHAIN_PORTFOLIO_SOURCES.map(async definition => {
        const account = active.availableChainAccounts.find(
          item => item.chain.family === definition.family
        )
        if (!account) return null
        const portfolio = definition.read(this.options)
        if (!portfolio) {
          throw new Error(`Enabled ${definition.label} Portfolio source is unavailable`)
        }
        const source = await atStage(definition.stage, () =>
          shouldRefreshChain(account.chain.id)
            ? portfolio.refreshActiveSource()
            : portfolio.readCachedActiveSource()
        )
        return Object.freeze({ account, source, label: definition.label })
      })
    )
    for (const entry of singleChainSources) {
      if (!entry) continue
      if (!entry.source) {
        if (action !== 'read') return null
        sources.push(uncachedSource(entry.account.chainAccount))
        continue
      }
      if (!sameActiveScope(entry.source, active.generationId, scope.keyDomainId, scope.accountId)) {
        return null
      }
      if (entry.source.chainAccount.id !== entry.account.chainAccount.id) {
        throw new Error(`${entry.label} Portfolio source does not match the active ChainAccount`)
      }
      sources.push(entry.source.source)
    }

    const starknetAccount = active.availableChainAccounts.find(
      item => item.chain.family === 'starknet'
    )
    if (starknetAccount) {
      const portfolio = this.options.starknetPortfolio
      if (!portfolio) throw new Error('Enabled Starknet Portfolio source is unavailable')
      const starknetSource = await atStage('starknet-source', () =>
        shouldRefreshChain(starknetAccount.chain.id)
          ? portfolio.refreshActiveSource()
          : portfolio.readCachedActiveSource()
      )
      if (!starknetSource) {
        if (action !== 'read') return null
        sources.push(uncachedSource(starknetAccount.chainAccount))
      } else {
        if (
          !sameActiveScope(starknetSource, active.generationId, scope.keyDomainId, scope.accountId)
        ) {
          return null
        }
        if (starknetSource.chainAccount.id !== starknetAccount.chainAccount.id) {
          throw new Error('Starknet Portfolio source does not match the active ChainAccount')
        }
        sources.push(starknetSource.source)
      }
    }

    const dashAccount = active.availableChainAccounts.find(item => item.chain.family === 'dash')
    if (dashAccount) {
      const dashPortfolio = this.options.dashPortfolio
      if (!dashPortfolio) throw new Error('Enabled Dash Portfolio source is unavailable')
      const dashSource = await atStage('dash-source', () =>
        shouldRefreshChain(dashAccount.chain.id)
          ? this.refreshDashInBackground(dashPortfolio)
          : this.readDashSource(dashPortfolio)
      )
      if (!dashSource) {
        if (action !== 'read') return null
        sources.push(uncachedSource(dashAccount.chainAccount))
      } else {
        if (!sameActiveScope(dashSource, active.generationId, scope.keyDomainId, scope.accountId)) {
          return null
        }
        if (dashSource.chainAccount.id !== dashAccount.chainAccount.id) {
          throw new Error('Dash Portfolio source does not match the active ChainAccount')
        }
        sources.push(dashSource.source)
      }
    }

    return atSynchronousStage('read-model', () =>
      buildPortfolioReadModel(scope, sources, this.options.chains, this.options.assets)
    )
  }

  private async readBitcoinSource(
    bitcoinPortfolio: BitcoinPortfolioSourceReader
  ): Promise<ActiveBitcoinPortfolioSource | null> {
    const cached = await bitcoinPortfolio.readCachedActiveSource()
    const background = this.backgroundBitcoinSource
    const useBackground = Boolean(
      cached &&
      background &&
      background.generationId === cached.generationId &&
      background.chainAccount.id === cached.chainAccount.id &&
      sourceUpdatedAt(background) >= sourceUpdatedAt(cached)
    )
    if (useBackground && background) {
      return background
    }
    return cached
  }

  private refreshBitcoinInBackground(
    bitcoinPortfolio: BitcoinPortfolioSourceReader
  ): Promise<ActiveBitcoinPortfolioSource | null> {
    void bitcoinPortfolio
      .refreshActiveSource()
      .then(source => {
        this.backgroundBitcoinSource = source
        this.options.onBackgroundBitcoinRefreshSettled?.(source)
      })
      .catch(error => {
        this.options.onBackgroundBitcoinRefreshError?.(error)
      })
    return this.readBitcoinSource(bitcoinPortfolio)
  }

  private async readPearlSource(
    pearlPortfolio: PearlPortfolioSourceReader
  ): Promise<ActivePearlPortfolioSource | null> {
    const cached = await pearlPortfolio.readCachedActiveSource()
    const background = this.backgroundPearlSource
    const useBackground = Boolean(
      cached &&
      background &&
      background.generationId === cached.generationId &&
      background.chainAccount.id === cached.chainAccount.id &&
      sourceUpdatedAt(background) >= sourceUpdatedAt(cached)
    )
    if (useBackground && background) {
      return background
    }
    return cached
  }

  private async readDashSource(
    dashPortfolio: DashPortfolioSourceReader
  ): Promise<ActiveDashPortfolioSource | null> {
    const cached = await dashPortfolio.readCachedActiveSource()
    const background = this.backgroundDashSource
    const useBackground = Boolean(
      cached &&
      background &&
      background.generationId === cached.generationId &&
      background.chainAccount.id === cached.chainAccount.id &&
      sourceUpdatedAt(background) >= sourceUpdatedAt(cached)
    )
    if (useBackground && background) {
      return background
    }
    return cached
  }

  private refreshPearlInBackground(
    pearlPortfolio: PearlPortfolioSourceReader
  ): Promise<ActivePearlPortfolioSource | null> {
    void pearlPortfolio
      .refreshActiveSource()
      .then(source => {
        this.backgroundPearlSource = source
        this.options.onBackgroundPearlRefreshSettled?.(source)
      })
      .catch(error => {
        this.options.onBackgroundPearlRefreshError?.(error)
      })
    return this.readPearlSource(pearlPortfolio)
  }

  private refreshDashInBackground(
    dashPortfolio: DashPortfolioSourceReader
  ): Promise<ActiveDashPortfolioSource | null> {
    void dashPortfolio
      .refreshActiveSource()
      .then(source => {
        this.backgroundDashSource = source
        this.options.onBackgroundDashRefreshSettled?.(source)
      })
      .catch(error => {
        this.options.onBackgroundDashRefreshError?.(error)
      })
    return this.readDashSource(dashPortfolio)
  }
}
