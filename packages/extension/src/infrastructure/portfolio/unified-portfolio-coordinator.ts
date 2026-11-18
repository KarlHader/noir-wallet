import { loadActiveReceiveWalletSet } from '@/core/accounts/application/active-wallet-set'
import type { AccountId } from '@/core/accounts/domain'
import type { AddressGatedChainRegistry, AssetRegistry } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  buildPortfolioReadModel,
  type PortfolioReadErrorCode,
  type PortfolioChainView,
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

const PORTFOLIO_SOURCE_CONCURRENCY = 8

interface PortfolioRefreshOptions {
  readonly awaitBitcoin?: boolean
  readonly requireNewBitcoinScan?: boolean
  readonly claimChainRefresh?: (chainId: string) => boolean
  readonly onChainRefreshed?: (chainId: string, chain?: PortfolioChainView) => void
}

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
  readonly refreshActiveSource: (
    options?: Readonly<{ requireNewScan?: boolean }>
  ) => Promise<ActiveBitcoinPortfolioSource | null>
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

  refreshActive(
    chainIds?: readonly string[],
    options: PortfolioRefreshOptions = {}
  ): Promise<PortfolioReadModel | null> {
    return this.readActive('refresh', chainIds, options)
  }

  private async readActive(
    action: 'read' | 'refresh',
    chainIds?: readonly string[],
    options: PortfolioRefreshOptions = {}
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

    const registrations = new Map<string, EvmPortfolioSourceReader>()
    if (availableChainAccounts.some(item => item.chain.family === 'evm')) {
      for (const registration of this.options.evmPortfolios ?? []) {
        if (registrations.has(registration.chainId)) {
          throw new Error('Enabled EVM Portfolio source is duplicated')
        }
        registrations.set(registration.chainId, registration.portfolio)
      }
    }

    const readBitcoin = (refresh: boolean) => {
      const bitcoinPortfolio = this.options.bitcoinPortfolio
      if (!bitcoinPortfolio) {
        throw new Error('Enabled Bitcoin Portfolio source is unavailable')
      }
      if (!refresh) return this.readBitcoinSource(bitcoinPortfolio)
      return options.awaitBitcoin
        ? bitcoinPortfolio.refreshActiveSource({ requireNewScan: options.requireNewBitcoinScan })
        : this.refreshBitcoinInBackground(bitcoinPortfolio)
    }

    const otherAccounts = availableChainAccounts.filter(({ chain }) => chain.family !== 'zcash')
    const otherSources = await mapWithConcurrency(
      otherAccounts,
      PORTFOLIO_SOURCE_CONCURRENCY,
      async ({ chain, chainAccount }) => {
        const family = chain.family
        if (family !== 'evm' && family !== 'bitcoin' && family !== 'solana' && family !== 'near')
          return undefined
        const refresh =
          shouldRefreshChain(chain.id) && (options.claimChainRefresh?.(chain.id) ?? true)
        const readSource = async () => {
          const source = await atStage(`${family}-source`, () => {
            if (family === 'bitcoin') return readBitcoin(refresh)
            const portfolio =
              family === 'evm'
                ? registrations.get(chain.id)
                : family === 'solana'
                  ? this.options.solanaPortfolio
                  : this.options.nearPortfolio
            if (!portfolio) throw new Error(`Enabled ${family} Portfolio source is unavailable`)
            return refresh ? portfolio.refreshActiveSource() : portfolio.readCachedActiveSource()
          })
          if (!source) return action === 'read' ? uncachedSource(chainAccount) : null
          if (!sameActiveScope(source, active.generationId, scope.keyDomainId, scope.accountId)) {
            return null
          }
          if (source.chainAccount.id !== chainAccount.id) {
            throw new Error(`${family} Portfolio source does not match the active ChainAccount`)
          }
          if (refresh && options.onChainRefreshed) {
            const [result] = buildPortfolioReadModel(
              scope,
              [source.source],
              this.options.chains,
              this.options.assets
            ).chains
            options.onChainRefreshed(chain.id, result)
          }
          return source.source
        }
        try {
          return await readSource()
        } catch (error) {
          if (!options.onChainRefreshed) throw error
          if (refresh) options.onChainRefreshed(chain.id)
          return null
        }
      }
    )
    for (const source of otherSources) {
      if (source === null) return null
      if (source) sources.push(source)
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
