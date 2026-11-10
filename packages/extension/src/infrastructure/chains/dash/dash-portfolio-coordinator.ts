import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { AssetRegistry, ChainRegistry } from '@/core/chains/registry'
import type {
  PortfolioReadErrorCode,
  PortfolioSourceSnapshot,
  PortfolioSourceStatus
} from '@/core/portfolio'
import type { StorageV2GenerationId } from '@/ports/repositories'
import { DashRpcError } from './dash-insight-codecs'
import { dashDiscoveryComplete, type DashDiscoveryState } from './dash-discovery-model'
import {
  loadActiveDashDiscoveryContext,
  type ActiveDashDiscoveryContext,
  type DashDiscoveryCoordinator,
  type DashDiscoveryStorageRepository
} from './dash-discovery-coordinator'
import { DashDiscoveryError } from './dash-gap-limit-scanner'
import type { DashInputReservationRepository } from './dash-input-reservation-model'
import { dashOutpointKey, summarizeDashObservations } from './dash-spendable-utxos'

export interface ActiveDashPortfolioSource {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly source: PortfolioSourceSnapshot
}

export interface DashPortfolioCoordinatorOptions {
  readonly storageRepository: DashDiscoveryStorageRepository
  readonly discovery: Pick<DashDiscoveryCoordinator, 'readCachedActive' | 'scanActive'>
  readonly inputReservations: Pick<DashInputReservationRepository, 'list'>
  readonly chainId: string
  readonly chains: ChainRegistry
  readonly assets: AssetRegistry
  readonly onRefreshError?: (
    error: unknown,
    context: ActiveDashDiscoveryContext
  ) => Promise<void> | void
}

function mapError(error: unknown): PortfolioReadErrorCode {
  if (error instanceof DashRpcError) {
    if (error.code === 'rate-limited') return 'rate-limited'
    if (error.code === 'unauthorized') return 'unauthorized'
    if (error.code === 'invalid-response' || error.code === 'chain-mismatch')
      return 'invalid-response'
    if (error.code === 'network-unavailable' || error.code === 'timeout')
      return 'network-unavailable'
  }
  if (error instanceof DashDiscoveryError && error.code === 'rpc-failure')
    return 'network-unavailable'
  return 'unknown'
}

export class DashPortfolioCoordinator {
  private readonly chainId: ChainId

  constructor(private readonly options: DashPortfolioCoordinatorOptions) {
    const chain = options.chains.resolve(options.chainId)
    if (chain.family !== 'dash') throw new Error('Dash Portfolio coordinator requires a Dash chain')
    const assets = options.assets.list(chain.id)
    if (
      assets.length !== 1 ||
      assets[0].asset.kind !== 'native' ||
      assets[0].asset.namespace !== 'slip44' ||
      assets[0].asset.reference !== '5'
    ) {
      throw new Error('Dash Portfolio coordinator requires the trusted DASH asset')
    }
    this.chainId = chain.id
  }

  async readCachedActiveSource(): Promise<ActiveDashPortfolioSource | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const state = await this.options.discovery.readCachedActive()
    if (!(await this.remainsActive(context))) return null
    if (state && state.chainAccount.id !== context.chainAccount.id) {
      throw new Error('Dash Portfolio discovery does not match the active ChainAccount')
    }
    return Object.freeze({
      generationId: context.generationId,
      chainAccount: context.chainAccount,
      source: await this.createSource(
        context,
        state,
        state && dashDiscoveryComplete(state) ? 'ready' : 'loading'
      )
    })
  }

  async refreshActiveSource(): Promise<ActiveDashPortfolioSource | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    try {
      const state = await this.options.discovery.scanActive({ forceRefresh: true })
      if (!state || !(await this.remainsActive(context))) return null
      if (state.chainAccount.id !== context.chainAccount.id) {
        throw new Error('Dash Portfolio discovery does not match the active ChainAccount')
      }
      return Object.freeze({
        generationId: context.generationId,
        chainAccount: context.chainAccount,
        source: await this.createSource(
          context,
          state,
          dashDiscoveryComplete(state) ? 'ready' : 'loading'
        )
      })
    } catch (error) {
      await Promise.resolve(this.options.onRefreshError?.(error, context)).catch(() => {})
      if (!(await this.remainsActive(context))) return null
      let state: DashDiscoveryState | null = null
      try {
        state = await this.options.discovery.readCachedActive()
      } catch {
        state = null
      }
      if (state && state.chainAccount.id !== context.chainAccount.id) {
        throw new Error('Dash Portfolio discovery does not match the active ChainAccount')
      }
      return Object.freeze({
        generationId: context.generationId,
        chainAccount: context.chainAccount,
        source: await this.createSource(context, state, 'error', mapError(error))
      })
    }
  }

  private async createSource(
    context: ActiveDashDiscoveryContext,
    state: DashDiscoveryState | null,
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
    const reserved = new Set<string>()
    for (const reservation of await this.options.inputReservations.list(context.scope)) {
      for (const outpoint of reservation.outpoints) {
        reserved.add(dashOutpointKey(outpoint.transactionId, outpoint.outputIndex))
      }
    }
    const totals = summarizeDashObservations(state.observations, reserved)
    return Object.freeze({
      chainAccount: context.chainAccount,
      status,
      balances: Object.freeze([
        Object.freeze({
          assetId: asset.asset.id,
          totalRaw: totals.total.toString(),
          spendableRaw: totals.spendable.toString(),
          availableRaw: totals.available.toString(),
          pendingRaw: totals.pending.toString(),
          updatedAt: state.updatedAt
        })
      ]),
      ...(errorCode === undefined ? {} : { errorCode })
    })
  }

  private loadActiveContext(): Promise<ActiveDashDiscoveryContext | null> {
    return loadActiveDashDiscoveryContext(this.options.storageRepository, this.chainId)
  }

  private async remainsActive(context: ActiveDashDiscoveryContext): Promise<boolean> {
    const pointer = await this.options.storageRepository.getActivePointer()
    return pointer?.generationId === context.generationId
  }
}
