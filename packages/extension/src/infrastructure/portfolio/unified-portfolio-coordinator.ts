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
import type { ActiveSingleChainPortfolioSource } from './single-chain-portfolio-coordinator'
import { readZcashPortfolioSource } from '@/infrastructure/chains/zcash'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import type { ZcashBalance } from '@/types'
import type { AccountNetworkFamily } from '@/core/wallet/account-network-selection'

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

export interface SingleChainPortfolioSourceReader {
  readonly readCachedActiveSource: () => Promise<ActiveSingleChainPortfolioSource | null>
  readonly refreshActiveSource: () => Promise<ActiveSingleChainPortfolioSource | null>
}

export interface UnifiedPortfolioCoordinatorOptions {
  readonly storageRepository: UnifiedPortfolioStorageRepository
  readonly chains: AddressGatedChainRegistry
  readonly assets: AssetRegistry
  readonly isNetworkEnabled?: (
    scope: {
      readonly keyDomainId: KeyDomainId
      readonly accountId: AccountId
    },
    family: AccountNetworkFamily,
    chainId: string
  ) => boolean | Promise<boolean>
  readonly evmPortfolios?: readonly EvmPortfolioSourceRegistration[]
  readonly bitcoinPortfolio?: BitcoinPortfolioSourceReader
  readonly solanaPortfolio?: SingleChainPortfolioSourceReader
  readonly nearPortfolio?: SingleChainPortfolioSourceReader
  readonly onBackgroundBitcoinRefreshError?: (error: unknown) => void
  readonly onBackgroundBitcoinRefreshSettled?: (source: ActiveBitcoinPortfolioSource | null) => void
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
  'solana-source',
  'near-source',
  'read-model'
] as const)

export type PortfolioCoordinatorStage = (typeof PORTFOLIO_COORDINATOR_STAGES)[number]

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

function sourceUpdatedAt(source: ActiveBitcoinPortfolioSource): number {
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
    const isSoftwareWallet =
      active.catalog.keyDomains.find(item => item.id === scope.keyDomainId)?.source.kind ===
      'software'
    const availableChainAccounts = await atStage('active-wallet', async () =>
      (
        await Promise.all(
          active.availableChainAccounts.map(async item =>
            !isSoftwareWallet ||
            !this.options.isNetworkEnabled ||
            (await this.options.isNetworkEnabled(scope, item.chain.family, item.chain.id))
              ? item
              : null
          )
        )
      ).flatMap(item => (item === null ? [] : [item]))
    )
    const refreshChainIds = chainIds ? new Set(chainIds) : null
    const shouldRefreshChain = (chainId: string) =>
      action === 'refresh' && (refreshChainIds === null || refreshChainIds.has(chainId))
    const sources: PortfolioSourceSnapshot[] = []
    const zcashAccount = availableChainAccounts.find(item => item.chain.family === 'zcash')
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

    const evmAccounts = availableChainAccounts.filter(item => item.chain.family === 'evm')
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

    const bitcoinAccount = availableChainAccounts.find(item => item.chain.family === 'bitcoin')
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

    const solanaAccount = availableChainAccounts.find(item => item.chain.family === 'solana')
    const nearAccount = availableChainAccounts.find(item => item.chain.family === 'near')
    const [solanaSource, nearSource] = await Promise.all([
      solanaAccount
        ? atStage('solana-source', () => {
            const portfolio = this.options.solanaPortfolio
            if (!portfolio) throw new Error('Enabled Solana Portfolio source is unavailable')
            return shouldRefreshChain(solanaAccount.chain.id)
              ? portfolio.refreshActiveSource()
              : portfolio.readCachedActiveSource()
          })
        : undefined,
      nearAccount
        ? atStage('near-source', () => {
            const portfolio = this.options.nearPortfolio
            if (!portfolio) throw new Error('Enabled NEAR Portfolio source is unavailable')
            return shouldRefreshChain(nearAccount.chain.id)
              ? portfolio.refreshActiveSource()
              : portfolio.readCachedActiveSource()
          })
        : undefined
    ])
    if (solanaAccount) {
      if (!solanaSource) {
        if (action !== 'read') return null
        sources.push(uncachedSource(solanaAccount.chainAccount))
      } else {
        if (
          !sameActiveScope(solanaSource, active.generationId, scope.keyDomainId, scope.accountId)
        ) {
          return null
        }
        if (solanaSource.chainAccount.id !== solanaAccount.chainAccount.id) {
          throw new Error('Solana Portfolio source does not match the active ChainAccount')
        }
        sources.push(solanaSource.source)
      }
    }

    if (nearAccount) {
      if (!nearSource) {
        if (action !== 'read') return null
        sources.push(uncachedSource(nearAccount.chainAccount))
      } else {
        if (!sameActiveScope(nearSource, active.generationId, scope.keyDomainId, scope.accountId)) {
          return null
        }
        if (nearSource.chainAccount.id !== nearAccount.chainAccount.id) {
          throw new Error('NEAR Portfolio source does not match the active ChainAccount')
        }
        sources.push(nearSource.source)
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
}
