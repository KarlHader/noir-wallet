import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { AssetRegistry, ChainRegistry } from '@/core/chains/registry'
import type {
  PortfolioReadErrorCode,
  PortfolioSourceSnapshot,
  PortfolioSourceStatus
} from '@/core/portfolio'
import type { StorageV2GenerationId } from '@/ports/repositories'
import type {
  ActivePearlDiscoveryContext,
  PearlDiscoveryCoordinator,
  PearlDiscoveryStorageRepository
} from './pearl-discovery-coordinator'
import type { PearlDiscoveryState } from './pearl-discovery-repository'
import { PearlDiscoveryError } from './pearl-gap-limit-scanner'
import type { PearlInputReservationRepository } from './pearl-input-reservation-model'
import { PearlRpcError } from './pearl-blockbook-error'
import {
  loadActivePearlDiscoveryContext,
  pearlDiscoveryComplete
} from './pearl-discovery-coordinator'
import { isActivePearlAddressObservation } from './pearl-spendable-utxos'

const DEFAULT_ADDRESS_SCHEME = 'pearl_p2tr' as const

export interface ActivePearlPortfolioSource {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly source: PortfolioSourceSnapshot
}

export interface PearlPortfolioCoordinatorOptions {
  readonly storageRepository: PearlDiscoveryStorageRepository
  readonly discovery: Pick<PearlDiscoveryCoordinator, 'readCachedActive' | 'scanActive'>
  readonly inputReservations: Pick<PearlInputReservationRepository, 'list'>
  readonly chainId: string
  readonly chains: ChainRegistry
  readonly assets: AssetRegistry
  readonly onRefreshError?: (
    error: unknown,
    context: ActivePearlDiscoveryContext
  ) => Promise<void> | void
}

export const PEARL_PORTFOLIO_STAGES = Object.freeze([
  'active-context',
  'discovery-cache',
  'active-pointer',
  'source-model'
] as const)

export type PearlPortfolioStage = (typeof PEARL_PORTFOLIO_STAGES)[number]

export class PearlPortfolioCoordinatorError extends Error {
  readonly stage: PearlPortfolioStage
  readonly cause: unknown

  constructor(stage: PearlPortfolioStage, cause: unknown) {
    super(`Pearl Portfolio ${stage} operation failed`)
    this.name = 'PearlPortfolioCoordinatorError'
    this.stage = stage
    this.cause = cause
  }
}

async function atPearlPortfolioStage<T>(
  stage: PearlPortfolioStage,
  operation: () => Promise<T> | T
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof PearlPortfolioCoordinatorError) throw error
    throw new PearlPortfolioCoordinatorError(stage, error)
  }
}

function mapError(error: unknown): PortfolioReadErrorCode {
  if (error instanceof PearlRpcError) {
    if (error.code === 'rate-limited') return 'rate-limited'
    if (error.code === 'unauthorized') return 'unauthorized'
    if (error.code === 'invalid-response' || error.code === 'chain-mismatch') {
      return 'invalid-response'
    }
    if (error.code === 'network-unavailable') {
      return 'network-unavailable'
    }
  }
  if (error instanceof PearlDiscoveryError && error.code === 'rpc-failure') {
    return 'network-unavailable'
  }
  return 'unknown'
}

function outpointKey(transactionId: string, outputIndex: number): string {
  return `${transactionId}:${outputIndex}`
}

export class PearlPortfolioCoordinator {
  private readonly chainId: ChainId

  constructor(private readonly options: PearlPortfolioCoordinatorOptions) {
    const chain = options.chains.resolve(options.chainId)
    if (chain.family !== 'pearl') {
      throw new Error('Pearl Portfolio coordinator requires a Pearl chain')
    }
    const assets = options.assets.list(chain.id)
    if (
      assets.length !== 1 ||
      assets[0].asset.kind !== 'native' ||
      assets[0].asset.namespace !== 'slip44' ||
      assets[0].asset.reference !== '808276'
    ) {
      throw new Error('Pearl Portfolio coordinator requires the trusted PRL asset')
    }
    this.chainId = chain.id
  }

  async readCachedActiveSource(): Promise<ActivePearlPortfolioSource | null> {
    const context = await atPearlPortfolioStage('active-context', () => this.loadActiveContext())
    if (!context) return null
    const state = await atPearlPortfolioStage('discovery-cache', () =>
      this.options.discovery.readCachedActive()
    )
    if (
      !(await atPearlPortfolioStage('active-pointer', () => this.contextRemainsActive(context)))
    ) {
      return null
    }
    if (state && state.chainAccount.id !== context.chainAccount.id) {
      throw new Error('Pearl Portfolio discovery does not match the active ChainAccount')
    }
    const source = await atPearlPortfolioStage('source-model', () =>
      this.createSource(
        context,
        state,
        state && pearlDiscoveryComplete(state) ? 'ready' : 'loading'
      )
    )
    return Object.freeze({ ...context, source })
  }

  async refreshActiveSource(): Promise<ActivePearlPortfolioSource | null> {
    const context = await atPearlPortfolioStage('active-context', () => this.loadActiveContext())
    if (!context) return null
    try {
      const cached = await atPearlPortfolioStage('discovery-cache', () =>
        this.options.discovery.readCachedActive()
      )
      const forceRefresh = await atPearlPortfolioStage('discovery-cache', () =>
        this.hasCommittedInputStillCached(context, cached)
      )
      const state = await this.options.discovery.scanActive({ forceRefresh })
      if (
        !state ||
        !(await atPearlPortfolioStage('active-pointer', () => this.contextRemainsActive(context)))
      ) {
        return null
      }
      if (state.chainAccount.id !== context.chainAccount.id) {
        throw new Error('Pearl Portfolio discovery does not match the active ChainAccount')
      }
      const source = await atPearlPortfolioStage('source-model', () =>
        this.createSource(context, state, pearlDiscoveryComplete(state) ? 'ready' : 'loading')
      )
      return Object.freeze({ ...context, source })
    } catch (error) {
      await Promise.resolve(this.options.onRefreshError?.(error, context)).catch(() => {})
      if (
        !(await atPearlPortfolioStage('active-pointer', () => this.contextRemainsActive(context)))
      ) {
        return null
      }
      const state = await atPearlPortfolioStage('discovery-cache', () =>
        this.options.discovery.readCachedActive()
      )
      if (state && state.chainAccount.id !== context.chainAccount.id) {
        throw new Error('Pearl Portfolio discovery does not match the active ChainAccount')
      }
      const source = await atPearlPortfolioStage('source-model', () =>
        this.createSource(context, state, 'error', mapError(error))
      )
      return Object.freeze({ ...context, source })
    }
  }

  private async createSource(
    context: ActivePearlDiscoveryContext,
    state: PearlDiscoveryState | null,
    status: PortfolioSourceStatus,
    errorCode?: PortfolioReadErrorCode
  ): Promise<PortfolioSourceSnapshot> {
    const asset = this.options.assets.list(this.chainId)[0]
    if (!state) {
      return Object.freeze({
        chainAccount: context.chainAccount,
        status,
        balances: Object.freeze([
          Object.freeze({
            assetId: asset.asset.id,
            totalRaw: '0',
            spendableRaw: '0',
            availableRaw: '0',
            pendingRaw: '0',
            updatedAt: 0
          })
        ]),
        ...(errorCode === undefined ? {} : { errorCode })
      })
    }
    const unavailable = new Set<string>()
    for (const reservation of await this.options.inputReservations.list({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex,
      addressScheme: DEFAULT_ADDRESS_SCHEME
    })) {
      for (const outpoint of reservation.outpoints) {
        unavailable.add(outpointKey(outpoint.transactionId, outpoint.outputIndex))
      }
    }
    const seen = new Set<string>()
    let total = 0n
    let spendable = 0n
    let available = 0n
    let pending = 0n
    for (const observation of state.observations) {
      if (!isActivePearlAddressObservation(observation)) continue
      for (const utxo of observation.utxos) {
        const key = outpointKey(utxo.transactionId, utxo.outputIndex)
        if (seen.has(key)) throw new Error('Duplicate Pearl Portfolio UTXO')
        seen.add(key)
        const value = BigInt(utxo.valueSats)
        total += value
        if (utxo.status.confirmed) {
          spendable += value
          if (!unavailable.has(key)) available += value
        } else {
          pending += value
        }
      }
    }
    return Object.freeze({
      chainAccount: context.chainAccount,
      status,
      balances: Object.freeze([
        Object.freeze({
          assetId: asset.asset.id,
          totalRaw: total.toString(),
          spendableRaw: spendable.toString(),
          availableRaw: available.toString(),
          pendingRaw: pending.toString(),
          updatedAt: state.updatedAt
        })
      ]),
      ...(errorCode === undefined ? {} : { errorCode })
    })
  }

  private loadActiveContext(): Promise<ActivePearlDiscoveryContext | null> {
    return loadActivePearlDiscoveryContext(this.options.storageRepository, this.chainId)
  }

  private async hasCommittedInputStillCached(
    context: ActivePearlDiscoveryContext,
    state: PearlDiscoveryState | null
  ): Promise<boolean> {
    if (!state) return false
    const cachedOutpoints = new Set(
      state.observations
        .filter(isActivePearlAddressObservation)
        .flatMap(observation =>
          observation.utxos.map(utxo => outpointKey(utxo.transactionId, utxo.outputIndex))
        )
    )
    if (cachedOutpoints.size === 0) return false
    const reservations = await this.options.inputReservations.list({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex,
      addressScheme: DEFAULT_ADDRESS_SCHEME
    })
    return reservations.some(
      reservation =>
        reservation.state === 'committed' &&
        reservation.outpoints.some(outpoint =>
          cachedOutpoints.has(outpointKey(outpoint.transactionId, outpoint.outputIndex))
        )
    )
  }

  private async contextRemainsActive(context: ActivePearlDiscoveryContext): Promise<boolean> {
    const pointer = await this.options.storageRepository.getActivePointer()
    return pointer?.generationId === context.generationId
  }
}
