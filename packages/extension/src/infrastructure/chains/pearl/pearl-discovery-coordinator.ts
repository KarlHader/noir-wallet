import { parseAccountIndex, type AccountIndex, type ChainAccount } from '@/core/accounts/domain'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type { PearlAddressObservation, PearlDiscoveryTarget } from '@/core/chains/pearl'
import {
  PEARL_DISCOVERY_TARGETS,
  PEARL_IMPORTED_PRIVATE_KEY_DISCOVERY_TARGETS
} from '@/core/chains/pearl'
import { getPearlChainId, parseChainId } from '@/core/chains/registry'
import { DedupPromise } from '@/lib/async-utils'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import type { PearlDiscoveryRefresher } from './pearl-discovery-refresh'
import type { PearlGapLimitScanner } from './pearl-gap-limit-scanner'
import type { PearlDiscoveryRepository, PearlDiscoveryState } from './pearl-discovery-repository'
import { parseScope } from './pearl-discovery-persistence-model'

export type PearlDiscoveryStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export interface ActivePearlDiscoveryContext {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly keyDomainSource: KeyDomainSource
}

export interface PearlDiscoveryCoordinatorOptions {
  readonly storageRepository: PearlDiscoveryStorageRepository
  readonly discoveryRepository: PearlDiscoveryRepository
  readonly scanner: PearlGapLimitScanner
  readonly refresher: PearlDiscoveryRefresher
  readonly chainId: string
  readonly targets?: readonly PearlDiscoveryTarget[]
  readonly gapLimit?: number
  readonly maximumAddressesPerTarget?: number
  readonly minimumRefreshIntervalMs?: number
  readonly onProgress?: (
    context: ActivePearlDiscoveryContext,
    observation: PearlAddressObservation
  ) => Promise<void> | void
  readonly now?: () => number
}

export interface ScanActivePearlDiscoveryOptions {
  readonly forceRefresh?: boolean
}

const DEFAULT_MINIMUM_REFRESH_INTERVAL_MS = 5 * 60_000
const MAXIMUM_MINIMUM_REFRESH_INTERVAL_MS = 10 * 60_000

export function pearlDiscoveryComplete(state: Pick<PearlDiscoveryState, 'checkpoint'>): boolean {
  return (
    state.checkpoint.cursors.length > 0 && state.checkpoint.cursors.every(cursor => cursor.complete)
  )
}

function parseMinimumRefreshInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_MINIMUM_REFRESH_INTERVAL_MS
  if (
    !Number.isSafeInteger(interval) ||
    interval < 0 ||
    interval > MAXIMUM_MINIMUM_REFRESH_INTERVAL_MS
  ) {
    throw new Error('Invalid Pearl discovery refresh interval')
  }
  return interval
}

function assertPearlChainAccount(
  chainAccount: ChainAccount,
  accountIndex: AccountIndex
): ChainAccount {
  return parseScope({ chainAccount, accountIndex }).chainAccount
}

export async function loadActivePearlDiscoveryContext(
  storageRepository: PearlDiscoveryStorageRepository,
  chainIdValue: string
): Promise<ActivePearlDiscoveryContext | null> {
  const chainId = parseChainId(chainIdValue).id
  if (chainId !== getPearlChainId('mainnet') && chainId !== getPearlChainId('testnet')) {
    throw new Error('Pearl discovery coordinator requires a supported Pearl chain ID')
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
  if (!keySourceSupportsChainFamily(keyDomain.source, 'pearl')) return null
  const accounts = snapshot.accounts.filter(
    account => account.id === active.accountId && account.keyDomainId === active.keyDomainId
  )
  if (accounts.length !== 1) {
    throw new Error('Active Account metadata is missing or ambiguous')
  }
  const accountIndex = parseAccountIndex(accounts[0].accountIndex)
  const candidates = snapshot.chainAccounts.filter(
    chainAccount =>
      chainAccount.scope.keyDomainId === active.keyDomainId &&
      chainAccount.scope.accountId === active.accountId &&
      chainAccount.scope.chainId === chainId
  )
  if (candidates.length === 0) return null
  if (candidates.length !== 1) {
    throw new Error('Active Account has ambiguous Pearl ChainAccounts')
  }
  return Object.freeze({
    generationId: pointer.generationId,
    chainAccount: assertPearlChainAccount(candidates[0], accountIndex),
    accountIndex,
    keyDomainSource: keyDomain.source
  })
}

export class PearlDiscoveryCoordinator {
  private readonly options: PearlDiscoveryCoordinatorOptions
  private readonly scans = new Map<string, DedupPromise<PearlDiscoveryState | null>>()
  private readonly lastRefreshAttempts = new Map<string, number>()
  private readonly minimumRefreshIntervalMs: number

  constructor(options: PearlDiscoveryCoordinatorOptions) {
    const chainId = parseChainId(options.chainId).id
    if (chainId !== getPearlChainId('mainnet') && chainId !== getPearlChainId('testnet')) {
      throw new Error('Pearl discovery coordinator requires a supported Pearl chain')
    }
    this.options = { ...options, chainId }
    this.minimumRefreshIntervalMs = parseMinimumRefreshInterval(options.minimumRefreshIntervalMs)
  }

  async readCachedActive(): Promise<PearlDiscoveryState | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    return this.options.discoveryRepository.get({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex
    })
  }

  async scanActive(
    options: ScanActivePearlDiscoveryOptions = {}
  ): Promise<PearlDiscoveryState | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const key = JSON.stringify([context.chainAccount.id, context.accountIndex])
    const gate = this.scans.get(key) ?? new DedupPromise<PearlDiscoveryState | null>()
    this.scans.set(key, gate)
    const result = await gate
      .run(() => this.scan(context, options.forceRefresh === true))
      .finally(() => {
        if (!gate.isPending) this.scans.delete(key)
      })
    if (result && !pearlDiscoveryComplete(result)) {
      return this.scanActive(options)
    }
    return result
  }

  private loadActiveContext(): Promise<ActivePearlDiscoveryContext | null> {
    return loadActivePearlDiscoveryContext(this.options.storageRepository, this.options.chainId)
  }

  private async scan(
    context: ActivePearlDiscoveryContext,
    forceRefresh: boolean
  ): Promise<PearlDiscoveryState | null> {
    const discoveryScope = Object.freeze({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex
    })
    const defaultTargets =
      this.options.targets ??
      (context.keyDomainSource.kind === 'private-key'
        ? PEARL_IMPORTED_PRIVATE_KEY_DISCOVERY_TARGETS
        : PEARL_DISCOVERY_TARGETS)
    const importedPrivateKey = context.keyDomainSource.kind === 'private-key'
    let cached = await this.options.discoveryRepository.get(discoveryScope)
    const targets =
      this.options.targets !== undefined ||
      cached?.checkpoint.cursors.some(cursor => cursor.target.change)
        ? defaultTargets
        : defaultTargets.filter(target => !target.change)
    if (cached !== null) {
      const existingCursors = cached.checkpoint.cursors
      if (
        existingCursors.length > targets.length ||
        existingCursors.some((cursor, index) => cursor.target.change !== targets[index]?.change)
      ) {
        throw new Error('Persisted Pearl discovery targets do not match the active policy')
      }
      if (existingCursors.length < targets.length) {
        const checkpoint = Object.freeze({
          ...cached.checkpoint,
          cursors: Object.freeze([
            ...existingCursors,
            ...targets.slice(existingCursors.length).map(target =>
              Object.freeze({
                target: Object.freeze({ ...target }),
                nextAddressIndex: 0,
                consecutiveUnused: 0,
                complete: false
              })
            )
          ])
        })
        await this.options.discoveryRepository.extendTargets({
          chainAccount: context.chainAccount,
          accountIndex: context.accountIndex,
          checkpoint,
          updatedAt: this.timestamp()
        })
        cached = await this.options.discoveryRepository.get(discoveryScope)
        if (!cached) throw new Error('Pearl discovery target extension was not persisted')
      }
      if (pearlDiscoveryComplete(cached)) {
        const refreshKey = JSON.stringify([context.chainAccount.id, context.accountIndex])
        const now = this.timestamp()
        const lastAttemptAt = Math.max(
          cached.updatedAt,
          this.lastRefreshAttempts.get(refreshKey) ?? 0
        )
        if (!forceRefresh && now - lastAttemptAt < this.minimumRefreshIntervalMs) {
          const currentPointer = await this.options.storageRepository.getActivePointer()
          return currentPointer?.generationId === context.generationId ? cached : null
        }
        this.lastRefreshAttempts.set(refreshKey, now)
        let refreshed: Awaited<ReturnType<PearlDiscoveryRefresher['refresh']>>
        try {
          refreshed = await this.options.refresher.refresh({
            state: cached,
            mode: 'active'
          })
        } catch (error) {
          // Provider cooldowns already pace repeated network attempts. Do not add a second
          // five-minute lockout after a failed refresh.
          this.lastRefreshAttempts.delete(refreshKey)
          throw error
        }
        await this.options.discoveryRepository.putRefresh({
          chainAccount: context.chainAccount,
          accountIndex: context.accountIndex,
          checkpoint: refreshed.checkpoint,
          observations: refreshed.observations,
          updatedAt: now
        })
        cached = await this.options.discoveryRepository.get(discoveryScope)
        if (!cached) throw new Error('Pearl discovery refresh was not persisted atomically')
      }
    }
    const result = await this.options.scanner.scan({
      keyDomainId: context.chainAccount.scope.keyDomainId,
      chainId: context.chainAccount.scope.chainId,
      accountIndex: context.accountIndex,
      targets,
      ...(importedPrivateKey ||
      (this.options.targets === undefined &&
        (cached === null || cached.checkpoint.maximumAddressesPerTarget === 1))
        ? { gapLimit: 1, maximumAddressesPerTarget: 1, fixedAddressCountPerTarget: 1 }
        : {
            ...(this.options.gapLimit === undefined ? {} : { gapLimit: this.options.gapLimit }),
            ...(this.options.maximumAddressesPerTarget === undefined
              ? {}
              : { maximumAddressesPerTarget: this.options.maximumAddressesPerTarget })
          }),
      ...(cached === null ? {} : { checkpoint: cached.checkpoint }),
      onProgress: async (observation, checkpoint) => {
        await this.options.discoveryRepository.putProgress({
          chainAccount: context.chainAccount,
          accountIndex: parseAccountIndex(context.accountIndex),
          checkpoint,
          observation,
          updatedAt: this.timestamp()
        })
        await this.options.onProgress?.(context, observation)
      }
    })
    const persisted = await this.options.discoveryRepository.get(discoveryScope)
    if (!persisted || JSON.stringify(persisted.checkpoint) !== JSON.stringify(result.checkpoint)) {
      throw new Error('Pearl discovery checkpoint was not persisted atomically')
    }
    const currentPointer = await this.options.storageRepository.getActivePointer()
    if (currentPointer?.generationId !== context.generationId) return null
    return persisted
  }

  private timestamp(): number {
    const value = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Pearl discovery progress timestamp')
    }
    return value
  }
}
