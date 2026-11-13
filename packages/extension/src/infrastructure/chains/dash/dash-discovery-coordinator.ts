import { parseAccountIndex, type AccountIndex, type ChainAccount } from '@/core/accounts/domain'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { KeyDomainSource } from '@/core/keyring/domain'
import { parseChainId } from '@/core/chains/registry'
import { isDashChainId } from '@/core/chains/registry/chain-ids'
import { DedupPromise } from '@/lib/async-utils'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import { DASH_MAX_ADDRESSES_PER_CHAIN } from './config'
import type { DashChangeReservationRepository } from './dash-change-reservation-model'
import { DashDiscoveryError, type DashGapLimitScanner } from './dash-gap-limit-scanner'
import {
  dashDiscoveryComplete,
  parseDashDiscoveryScope,
  type DashDerivedAddress,
  type DashDiscoveryCheckpoint,
  type DashDiscoveryCursor,
  type DashDiscoveryObservation,
  type DashDiscoveryRepository,
  type DashDiscoveryScope,
  type DashDiscoveryState
} from './dash-discovery-model'

export type DashDiscoveryStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export interface ActiveDashDiscoveryContext {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly keyDomainSource: KeyDomainSource
  readonly scope: DashDiscoveryScope
}

export interface DashDiscoveryCoordinatorOptions {
  readonly storageRepository: DashDiscoveryStorageRepository
  readonly discoveryRepository: DashDiscoveryRepository
  readonly scanner: DashGapLimitScanner
  readonly chainId: string
  readonly changeReservations?: Pick<DashChangeReservationRepository, 'list'>
  readonly minimumRefreshIntervalMs?: number
  readonly now?: () => number
}

export interface ScanActiveDashDiscoveryOptions {
  readonly forceRefresh?: boolean
}

const DEFAULT_MINIMUM_REFRESH_INTERVAL_MS = 5 * 60_000
const MAXIMUM_MINIMUM_REFRESH_INTERVAL_MS = 10 * 60_000

function replaceCursor(
  checkpoint: DashDiscoveryCheckpoint,
  change: boolean,
  cursor: DashDiscoveryCursor
): DashDiscoveryCheckpoint {
  return Object.freeze({
    ...checkpoint,
    cursors: Object.freeze(checkpoint.cursors.map(item => (item.change === change ? cursor : item)))
  })
}

function observationKey(observation: DashDiscoveryObservation): string {
  return `${observation.derived.change ? 1 : 0}:${observation.derived.addressIndex}`
}

function mergeObservations(
  current: readonly DashDiscoveryObservation[],
  extra: readonly DashDiscoveryObservation[]
): readonly DashDiscoveryObservation[] {
  const merged = new Map<string, DashDiscoveryObservation>()
  for (const observation of current) merged.set(observationKey(observation), observation)
  for (const observation of extra) merged.set(observationKey(observation), observation)
  return Object.freeze([...merged.values()])
}

function boundChangeAddress(reservation: {
  readonly state: string
  readonly addressIndex: number
  readonly address?: DashDerivedAddress | null
}): DashDerivedAddress | null {
  if (reservation.state !== 'committed' && reservation.state !== 'reserved') return null
  const address = reservation.address
  if (!address || address.change !== true || address.addressIndex !== reservation.addressIndex) {
    return null
  }
  if (typeof address.address !== 'string' || address.address.length === 0) return null
  return address
}

function cursorSignature(checkpoint: DashDiscoveryCheckpoint): string {
  return checkpoint.cursors
    .map(cursor =>
      [
        cursor.change ? 1 : 0,
        cursor.nextAddressIndex,
        cursor.consecutiveUnused,
        cursor.complete ? 1 : 0,
        cursor.nextPage
      ].join(':')
    )
    .join('|')
}

function parseMinimumRefreshInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_MINIMUM_REFRESH_INTERVAL_MS
  if (
    !Number.isSafeInteger(interval) ||
    interval < 0 ||
    interval > MAXIMUM_MINIMUM_REFRESH_INTERVAL_MS
  ) {
    throw new Error('Invalid Dash discovery refresh interval')
  }
  return interval
}

function reopenDashGap(
  checkpoint: DashDiscoveryCheckpoint,
  observations: readonly DashDiscoveryObservation[],
  reservations: readonly { readonly state: string; readonly addressIndex: number }[]
): DashDiscoveryCheckpoint {
  if (checkpoint.imported) return checkpoint
  const observedChange = new Set(
    observations
      .filter(observation => observation.derived.change)
      .map(observation => observation.derived.addressIndex)
  )
  const reservedChangeIndexes = reservations.flatMap(reservation =>
    reservation.state !== 'abandoned' &&
    Number.isSafeInteger(reservation.addressIndex) &&
    reservation.addressIndex >= 0 &&
    !observedChange.has(reservation.addressIndex)
      ? [reservation.addressIndex]
      : []
  )
  const cursors = checkpoint.cursors.map(cursor => {
    const firstUnused = cursor.nextAddressIndex - cursor.consecutiveUnused
    const revived = cursor.complete
      ? observations
          .filter(
            observation =>
              observation.derived.change === cursor.change &&
              observation.derived.addressIndex >= firstUnused &&
              observation.derived.addressIndex < cursor.nextAddressIndex &&
              observation.transactions.length > 0
          )
          .sort((left, right) => left.derived.addressIndex - right.derived.addressIndex)[0]
      : undefined
    const reservedBeyondCursor =
      cursor.change &&
      reservedChangeIndexes.some(addressIndex => addressIndex >= cursor.nextAddressIndex)
    if (!revived && !reservedBeyondCursor) return cursor
    const reopened: DashDiscoveryCursor = Object.freeze({
      change: cursor.change,
      nextAddressIndex: revived ? revived.derived.addressIndex + 1 : cursor.nextAddressIndex,
      consecutiveUnused: 0,
      complete: false,
      nextPage: 0
    })
    return reopened
  })
  return Object.freeze({ ...checkpoint, cursors: Object.freeze(cursors) })
}

export async function loadActiveDashDiscoveryContext(
  storageRepository: DashDiscoveryStorageRepository,
  chainIdValue: string
): Promise<ActiveDashDiscoveryContext | null> {
  const chainId = parseChainId(chainIdValue).id
  if (!isDashChainId(chainId)) throw new Error('Dash discovery requires a Dash chain')
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
  const accounts = snapshot.accounts.filter(
    account => account.id === active.accountId && account.keyDomainId === active.keyDomainId
  )
  if (accounts.length !== 1) throw new Error('Active Account metadata is missing or ambiguous')
  const accountIndex = parseAccountIndex(accounts[0].accountIndex)
  const candidates = snapshot.chainAccounts.filter(
    chainAccount =>
      chainAccount.scope.keyDomainId === active.keyDomainId &&
      chainAccount.scope.accountId === active.accountId &&
      chainAccount.scope.chainId === chainId
  )
  if (candidates.length === 0) return null
  if (candidates.length !== 1) throw new Error('Active Account has ambiguous Dash ChainAccounts')
  const chainAccount = candidates[0]
  if (
    !keySourceSupportsChainFamily(keyDomain.source, 'dash') &&
    chainAccount.derivation.scheme !== 'imported'
  ) {
    return null
  }
  const scope = parseDashDiscoveryScope({ chainAccount, accountIndex })
  return Object.freeze({
    generationId: pointer.generationId,
    chainAccount: scope.chainAccount,
    accountIndex,
    keyDomainSource: keyDomain.source,
    scope
  })
}

export class DashDiscoveryCoordinator {
  private readonly options: DashDiscoveryCoordinatorOptions
  private readonly scans = new Map<string, DedupPromise<DashDiscoveryState | null>>()
  private readonly lastRefreshAttempts = new Map<string, number>()
  private readonly minimumRefreshIntervalMs: number
  private readonly now: () => number

  constructor(options: DashDiscoveryCoordinatorOptions) {
    const chainId = parseChainId(options.chainId).id
    if (!isDashChainId(chainId)) throw new Error('Dash discovery requires a Dash chain')
    this.options = { ...options, chainId }
    this.minimumRefreshIntervalMs = parseMinimumRefreshInterval(options.minimumRefreshIntervalMs)
    this.now = options.now ?? Date.now
  }

  async readCachedActive(): Promise<DashDiscoveryState | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const state = await this.options.discoveryRepository.get(context.scope)
    if (!state) return null
    if (
      state.chainAccount.id !== context.chainAccount.id ||
      state.network !== context.scope.network
    ) {
      return null
    }
    return state
  }

  async scanActive(
    options: ScanActiveDashDiscoveryOptions = {}
  ): Promise<DashDiscoveryState | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const key = JSON.stringify([
      context.scope.network,
      context.chainAccount.scope.keyDomainId,
      context.chainAccount.scope.accountId,
      context.chainAccount.id
    ])
    const gate = this.scans.get(key) ?? new DedupPromise<DashDiscoveryState | null>()
    this.scans.set(key, gate)
    return gate
      .run(() => this.scan(context, options.forceRefresh === true))
      .finally(() => {
        if (!gate.isPending) this.scans.delete(key)
      })
  }

  private async scan(
    context: ActiveDashDiscoveryContext,
    forceRefresh: boolean
  ): Promise<DashDiscoveryState | null> {
    const cached = await this.options.discoveryRepository.get(context.scope)
    if (cached && dashDiscoveryComplete(cached)) {
      const now = this.timestamp()
      const lastAttemptAt = Math.max(
        cached.updatedAt,
        this.lastRefreshAttempts.get(context.chainAccount.id) ?? 0
      )
      if (!forceRefresh && now - lastAttemptAt < this.minimumRefreshIntervalMs) {
        return (await this.remainsActive(context)) ? cached : null
      }
      this.lastRefreshAttempts.set(context.chainAccount.id, now)
      try {
        const observations = await this.options.scanner.reload(cached.observations)
        const reservations = this.options.changeReservations
          ? await this.options.changeReservations.list(context.scope)
          : []
        await this.persistRecoveredGap(context, cached.checkpoint, observations, reservations)
      } catch (error) {
        this.lastRefreshAttempts.delete(context.chainAccount.id)
        throw error
      }
      if (!(await this.remainsActive(context))) return null
      return this.options.discoveryRepository.get(context.scope)
    }

    const result = await this.options.scanner.scan({
      keyDomainId: context.chainAccount.scope.keyDomainId,
      scope: context.scope,
      ...(cached ? { checkpoint: cached.checkpoint, observations: cached.observations } : {}),
      onProgress: async (observation, checkpoint) => {
        await this.options.discoveryRepository.putProgress({
          ...context.scope,
          checkpoint,
          observation,
          updatedAt: this.timestamp()
        })
      }
    })
    if (!(await this.remainsActive(context))) return null
    if (!dashDiscoveryComplete({ checkpoint: result.checkpoint })) {
      throw new DashDiscoveryError(
        'checkpoint-failure',
        result.checkpoint,
        'Dash discovery stopped before the gap limit'
      )
    }
    const reservations = this.options.changeReservations
      ? await this.options.changeReservations.list(context.scope)
      : []
    await this.persistRecoveredGap(context, result.checkpoint, result.observations, reservations)
    if (!(await this.remainsActive(context))) return null
    return this.options.discoveryRepository.get(context.scope)
  }

  private async persistRecoveredGap(
    context: ActiveDashDiscoveryContext,
    startCheckpoint: DashDiscoveryCheckpoint,
    startObservations: readonly DashDiscoveryObservation[],
    reservations: readonly {
      readonly state: string
      readonly addressIndex: number
      readonly address?: DashDerivedAddress | null
    }[]
  ): Promise<void> {
    let checkpoint = startCheckpoint
    let observations = startObservations
    const seen = new Set<string>()
    for (let round = 0; round < DASH_MAX_ADDRESSES_PER_CHAIN; round += 1) {
      const anchored = await this.anchorReservedChange(observations, reservations)
      observations = mergeObservations(observations, anchored)
      checkpoint = reopenDashGap(checkpoint, observations, reservations)
      const looked = await this.reopenFromLookahead(context, checkpoint, observations)
      checkpoint = looked.checkpoint
      observations = mergeObservations(observations, looked.observations)
      const signature = cursorSignature(checkpoint)
      const fresh = !seen.has(signature)
      seen.add(signature)
      await this.options.discoveryRepository.putRefresh({
        ...context.scope,
        checkpoint,
        observations,
        updatedAt: this.timestamp()
      })
      if (checkpoint.cursors.every(cursor => cursor.complete) || !fresh) return
      await this.extend(context, checkpoint, observations)
      const state = await this.options.discoveryRepository.get(context.scope)
      if (!state) return
      checkpoint = state.checkpoint
      observations = state.observations
    }
  }

  private async anchorReservedChange(
    observations: readonly DashDiscoveryObservation[],
    reservations: readonly {
      readonly state: string
      readonly addressIndex: number
      readonly address?: DashDerivedAddress | null
    }[]
  ): Promise<readonly DashDiscoveryObservation[]> {
    const anchored: DashDiscoveryObservation[] = []
    for (const reservation of reservations) {
      const address = boundChangeAddress(reservation)
      if (!address) continue
      const exists = observations.some(
        observation =>
          observation.derived.change === address.change &&
          observation.derived.addressIndex === address.addressIndex
      )
      if (exists) continue
      anchored.push(await this.options.scanner.observeDerived(address))
    }
    return Object.freeze(anchored)
  }

  private async reopenFromLookahead(
    context: ActiveDashDiscoveryContext,
    checkpoint: DashDiscoveryCheckpoint,
    observations: readonly DashDiscoveryObservation[]
  ): Promise<{
    readonly checkpoint: DashDiscoveryCheckpoint
    readonly observations: readonly DashDiscoveryObservation[]
  }> {
    if (checkpoint.imported) {
      return { checkpoint, observations: Object.freeze([]) }
    }
    let next = checkpoint
    const found: DashDiscoveryObservation[] = []
    for (const cursor of checkpoint.cursors) {
      if (!cursor.complete) continue
      const funded = await this.options.scanner.probeAhead({
        keyDomainId: context.chainAccount.scope.keyDomainId,
        scope: context.scope,
        checkpoint: next,
        cursor
      })
      if (funded.length === 0) continue
      for (const derived of funded) {
        const known =
          observations.some(
            observation =>
              observation.derived.change === derived.change &&
              observation.derived.addressIndex === derived.addressIndex
          ) ||
          found.some(
            observation =>
              observation.derived.change === derived.change &&
              observation.derived.addressIndex === derived.addressIndex
          )
        if (known) continue
        found.push(await this.options.scanner.observeDerived(derived))
      }
      const nextAddressIndex = funded[funded.length - 1].addressIndex + 1
      if (nextAddressIndex >= DASH_MAX_ADDRESSES_PER_CHAIN) continue
      next = replaceCursor(next, cursor.change, {
        change: cursor.change,
        nextAddressIndex,
        consecutiveUnused: 0,
        complete: false,
        nextPage: 0
      })
    }
    return { checkpoint: next, observations: Object.freeze(found) }
  }

  private async extend(
    context: ActiveDashDiscoveryContext,
    checkpoint: DashDiscoveryCheckpoint,
    observations: readonly DashDiscoveryObservation[]
  ): Promise<void> {
    await this.options.scanner.scan({
      keyDomainId: context.chainAccount.scope.keyDomainId,
      scope: context.scope,
      checkpoint,
      observations,
      onProgress: async (observation, nextCheckpoint) => {
        await this.options.discoveryRepository.putProgress({
          ...context.scope,
          checkpoint: nextCheckpoint,
          observation,
          updatedAt: this.timestamp()
        })
      }
    })
  }

  private loadActiveContext(): Promise<ActiveDashDiscoveryContext | null> {
    return loadActiveDashDiscoveryContext(this.options.storageRepository, this.options.chainId)
  }

  private async remainsActive(context: ActiveDashDiscoveryContext): Promise<boolean> {
    const pointer = await this.options.storageRepository.getActivePointer()
    return pointer?.generationId === context.generationId
  }

  private timestamp(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid Dash discovery timestamp')
    return now
  }
}
