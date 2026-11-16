import { parseAccountIndex, type AccountIndex, type ChainAccount } from '@/core/accounts/domain'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type {
  BitcoinAddressObservation,
  BitcoinDiscoveryTarget,
  BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import {
  BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS,
  BITCOIN_HARDWARE_DISCOVERY_TARGETS,
  BITCOIN_IMPORTED_PRIVATE_KEY_DISCOVERY_TARGETS,
  BITCOIN_DEFAULT_GAP_LIMIT,
  BITCOIN_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
  BITCOIN_MAXIMUM_GAP_LIMIT
} from '@/core/chains/bitcoin'
import { parseChainId } from '@/core/chains/registry'
import { DedupPromise } from '@/lib/async-utils'
import type { StorageV2GenerationId, StorageV2ReadRepository } from '@/ports/repositories'
import type { BitcoinDiscoveryRefresher } from './bitcoin-discovery-refresh'
import type { BitcoinGapLimitScanner } from './bitcoin-gap-limit-scanner'
import type {
  BitcoinDiscoveryRepository,
  BitcoinDiscoveryState
} from './bitcoin-discovery-repository'
import {
  isFixedSingleAddressBitcoinCheckpoint,
  parseScope
} from './bitcoin-discovery-persistence-model'
import { bitcoinAccountRootFromPath } from './bitcoin-transaction-model'
import { isLedgerBitcoinAccountObservation } from './bitcoin-spendable-utxos'

export type BitcoinDiscoveryStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export interface ActiveBitcoinDiscoveryContext {
  readonly generationId: StorageV2GenerationId
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly keyDomainSource: KeyDomainSource
}

export interface BitcoinDiscoveryCoordinatorOptions {
  readonly storageRepository: BitcoinDiscoveryStorageRepository
  readonly discoveryRepository: BitcoinDiscoveryRepository
  readonly scanner: BitcoinGapLimitScanner
  readonly refresher: BitcoinDiscoveryRefresher
  readonly chainId: string
  readonly targets?: readonly BitcoinDiscoveryTarget[]
  readonly gapLimit?: number
  readonly maximumAddressesPerTarget?: number
  readonly minimumRefreshIntervalMs?: number
  readonly onProgress?: (
    context: ActiveBitcoinDiscoveryContext,
    observation: BitcoinAddressObservation
  ) => Promise<void> | void
  readonly now?: () => number
}

export interface ScanActiveBitcoinDiscoveryOptions {
  readonly forceRefresh?: boolean
  readonly addressType?: BitcoinSupportedAddressType
}

const DEFAULT_MINIMUM_REFRESH_INTERVAL_MS = 5 * 60_000
const MAXIMUM_MINIMUM_REFRESH_INTERVAL_MS = 10 * 60_000
const DEFAULT_ADDRESS_TYPE: BitcoinSupportedAddressType = 'p2wpkh'

export function bitcoinDiscoveryAddressTypeComplete(
  state: Pick<BitcoinDiscoveryState, 'checkpoint'>,
  addressType: BitcoinSupportedAddressType
): boolean {
  const cursors = state.checkpoint.cursors.filter(
    cursor => cursor.target.addressType === addressType
  )
  return cursors.length > 0 && cursors.every(cursor => cursor.complete)
}

function parseMinimumRefreshInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_MINIMUM_REFRESH_INTERVAL_MS
  if (
    !Number.isSafeInteger(interval) ||
    interval < 0 ||
    interval > MAXIMUM_MINIMUM_REFRESH_INTERVAL_MS
  ) {
    throw new Error('Invalid Bitcoin discovery refresh interval')
  }
  return interval
}

function assertBitcoinChainAccount(
  chainAccount: ChainAccount,
  accountIndex: AccountIndex
): ChainAccount {
  return parseScope({ chainAccount, accountIndex }).chainAccount
}

export async function loadActiveBitcoinDiscoveryContext(
  storageRepository: BitcoinDiscoveryStorageRepository,
  chainIdValue: string
): Promise<ActiveBitcoinDiscoveryContext | null> {
  const chainId = parseChainId(chainIdValue).id
  if (
    chainId !== 'bip122:000000000019d6689c085ae165831e93' &&
    chainId !== 'bip122:000000000933ea01ad0ee984209779ba'
  ) {
    throw new Error('Bitcoin discovery coordinator requires a supported Bitcoin chain ID')
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
  if (!keySourceSupportsChainFamily(keyDomain.source, 'bitcoin')) return null
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
    throw new Error('Active Account has ambiguous Bitcoin ChainAccounts')
  }
  return Object.freeze({
    generationId: pointer.generationId,
    chainAccount: assertBitcoinChainAccount(candidates[0], accountIndex),
    accountIndex,
    keyDomainSource: keyDomain.source
  })
}

export class BitcoinDiscoveryCoordinator {
  private readonly options: BitcoinDiscoveryCoordinatorOptions
  private readonly scans = new Map<string, DedupPromise<BitcoinDiscoveryState | null>>()
  private readonly lastRefreshAttempts = new Map<string, number>()
  private readonly minimumRefreshIntervalMs: number

  constructor(options: BitcoinDiscoveryCoordinatorOptions) {
    const chainId = parseChainId(options.chainId).id
    if (
      chainId !== 'bip122:000000000019d6689c085ae165831e93' &&
      chainId !== 'bip122:000000000933ea01ad0ee984209779ba'
    ) {
      throw new Error('Bitcoin discovery coordinator requires a supported Bitcoin chain')
    }
    this.options = { ...options, chainId }
    this.minimumRefreshIntervalMs = parseMinimumRefreshInterval(options.minimumRefreshIntervalMs)
  }

  async readCachedActive(): Promise<BitcoinDiscoveryState | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    return this.options.discoveryRepository.get({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex
    })
  }

  async scanActive(
    options: ScanActiveBitcoinDiscoveryOptions = {}
  ): Promise<BitcoinDiscoveryState | null> {
    const context = await this.loadActiveContext()
    if (!context) return null
    const addressType = options.addressType ?? DEFAULT_ADDRESS_TYPE
    const key = JSON.stringify([context.chainAccount.id, context.accountIndex])
    const gate = this.scans.get(key) ?? new DedupPromise<BitcoinDiscoveryState | null>()
    this.scans.set(key, gate)
    const result = await gate
      .run(() => this.scan(context, addressType, options.forceRefresh === true))
      .finally(() => {
        if (!gate.isPending) this.scans.delete(key)
      })
    if (result && !bitcoinDiscoveryAddressTypeComplete(result, addressType)) {
      return this.scanActive(options)
    }
    return result
  }

  async ensureLedgerChangeAddress(
    scope: Pick<ActiveBitcoinDiscoveryContext, 'chainAccount' | 'accountIndex'>,
    addressIndex: number
  ): Promise<BitcoinAddressObservation> {
    const context = await this.loadActiveContext()
    if (
      !context ||
      context.keyDomainSource.kind !== 'hardware' ||
      context.keyDomainSource.vendor !== 'ledger' ||
      context.chainAccount.id !== scope.chainAccount.id ||
      context.accountIndex !== scope.accountIndex ||
      context.chainAccount.derivation.path !== scope.chainAccount.derivation.path ||
      context.chainAccount.scope.keyDomainId !== scope.chainAccount.scope.keyDomainId ||
      context.chainAccount.scope.accountId !== scope.chainAccount.scope.accountId ||
      context.chainAccount.scope.chainId !== scope.chainAccount.scope.chainId ||
      !Number.isSafeInteger(addressIndex) ||
      addressIndex < 0
    ) {
      throw new Error('Ledger Bitcoin change scope does not match the active account')
    }
    const accountRoot = bitcoinAccountRootFromPath(
      context.chainAccount.derivation.path,
      context.chainAccount.scope.chainId,
      'p2wpkh',
      false,
      0
    )
    const discoveryScope = {
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex
    }
    const key = JSON.stringify([context.chainAccount.id, context.accountIndex])
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const gate = this.scans.get(key) ?? new DedupPromise<BitcoinDiscoveryState | null>()
      this.scans.set(key, gate)
      const state = await gate
        .run(async () => {
          const cached = await this.options.discoveryRepository.get(discoveryScope)
          if (!cached) {
            throw new Error(
              'Ledger Bitcoin change discovery must complete before reserving an address'
            )
          }
          if (!bitcoinDiscoveryAddressTypeComplete(cached, 'p2wpkh')) {
            return this.scan(context, 'p2wpkh', false)
          }
          const observed = cached.observations.find(
            item =>
              item.derived.addressType === 'p2wpkh' &&
              item.derived.change &&
              item.derived.addressIndex === addressIndex
          )
          if (observed) return cached
          const changeCursor = cached.checkpoint.cursors.find(
            cursor => cursor.target.addressType === 'p2wpkh' && cursor.target.change
          )
          if (!changeCursor || !changeCursor.complete) {
            throw new Error(
              'Ledger Bitcoin change discovery must complete before reserving an address'
            )
          }
          const gapLimit = Math.max(
            cached.checkpoint.gapLimit,
            addressIndex - changeCursor.nextAddressIndex + changeCursor.consecutiveUnused + 1
          )
          if (
            gapLimit > BITCOIN_MAXIMUM_GAP_LIMIT ||
            addressIndex >= cached.checkpoint.maximumAddressesPerTarget
          ) {
            throw new Error('Ledger Bitcoin change address exceeds discovery limit')
          }
          await this.options.discoveryRepository.extendTargets({
            ...discoveryScope,
            checkpoint: Object.freeze({
              ...cached.checkpoint,
              gapLimit,
              cursors: Object.freeze(
                cached.checkpoint.cursors.map(cursor =>
                  Object.freeze({
                    ...cursor,
                    complete: cursor.consecutiveUnused === gapLimit
                  })
                )
              )
            }),
            updatedAt: this.timestamp()
          })
          return this.scan(context, 'p2wpkh', false)
        })
        .finally(() => {
          if (!gate.isPending) this.scans.delete(key)
        })
      const observation = state?.observations.find(
        item =>
          item.derived.addressType === 'p2wpkh' &&
          item.derived.change &&
          item.derived.addressIndex === addressIndex
      )
      if (observation) {
        isLedgerBitcoinAccountObservation(observation, accountRoot)
        return observation
      }
    }
    throw new Error('Ledger Bitcoin change address was not discovered')
  }

  private loadActiveContext(): Promise<ActiveBitcoinDiscoveryContext | null> {
    return loadActiveBitcoinDiscoveryContext(this.options.storageRepository, this.options.chainId)
  }

  private async scan(
    context: ActiveBitcoinDiscoveryContext,
    addressType: BitcoinSupportedAddressType,
    forceRefresh: boolean
  ): Promise<BitcoinDiscoveryState | null> {
    const discoveryScope = Object.freeze({
      chainAccount: context.chainAccount,
      accountIndex: context.accountIndex
    })
    const defaultTargets =
      this.options.targets ??
      (context.keyDomainSource.kind === 'hardware'
        ? BITCOIN_HARDWARE_DISCOVERY_TARGETS
        : context.keyDomainSource.kind === 'private-key'
          ? BITCOIN_IMPORTED_PRIVATE_KEY_DISCOVERY_TARGETS
          : BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS)
    const importedPrivateKey = context.keyDomainSource.kind === 'private-key'
    const ledgerAccount =
      context.keyDomainSource.kind === 'hardware' && context.keyDomainSource.vendor === 'ledger'
    let cached = await this.options.discoveryRepository.get(discoveryScope)
    if (
      ledgerAccount &&
      this.options.targets === undefined &&
      cached &&
      isFixedSingleAddressBitcoinCheckpoint(cached.checkpoint)
    ) {
      const checkpoint = Object.freeze({
        ...cached.checkpoint,
        gapLimit: this.options.gapLimit ?? BITCOIN_DEFAULT_GAP_LIMIT,
        maximumAddressesPerTarget:
          this.options.maximumAddressesPerTarget ?? BITCOIN_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
        cursors: Object.freeze(
          BITCOIN_HARDWARE_DISCOVERY_TARGETS.map(target => {
            const existing = cached?.checkpoint.cursors.find(
              cursor =>
                cursor.target.addressType === target.addressType &&
                cursor.target.change === target.change
            )
            const observation = cached?.observations.find(
              item =>
                item.derived.addressType === target.addressType &&
                item.derived.change === target.change &&
                item.derived.addressIndex === 0
            )
            return Object.freeze({
              target,
              nextAddressIndex: existing?.nextAddressIndex ?? 0,
              consecutiveUnused: observation?.activity.used === false ? 1 : 0,
              complete:
                observation?.activity.used === false &&
                (this.options.gapLimit ?? BITCOIN_DEFAULT_GAP_LIMIT) === 1
            })
          })
        )
      })
      await this.options.discoveryRepository.extendTargets({
        ...discoveryScope,
        checkpoint,
        updatedAt: this.timestamp()
      })
      cached = await this.options.discoveryRepository.get(discoveryScope)
      if (!cached) throw new Error('Ledger Bitcoin discovery upgrade was not persisted')
    }
    const targets =
      ledgerAccount ||
      this.options.targets !== undefined ||
      cached?.checkpoint.cursors.some(cursor => cursor.target.change)
        ? defaultTargets
        : defaultTargets.filter(target => !target.change)
    if (cached !== null) {
      const existingCursors = cached.checkpoint.cursors
      if (
        existingCursors.length > targets.length ||
        existingCursors.some(
          (cursor, index) =>
            cursor.target.addressType !== targets[index]?.addressType ||
            cursor.target.change !== targets[index]?.change
        )
      ) {
        throw new Error('Persisted Bitcoin discovery targets do not match the active policy')
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
        if (!cached) throw new Error('Bitcoin discovery target extension was not persisted')
      }
      if (bitcoinDiscoveryAddressTypeComplete(cached, addressType)) {
        const refreshKey = JSON.stringify([
          context.chainAccount.id,
          context.accountIndex,
          addressType
        ])
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
        let refreshed: Awaited<ReturnType<BitcoinDiscoveryRefresher['refresh']>>
        try {
          refreshed = await this.options.refresher.refresh({
            state: cached,
            mode: ledgerAccount ? 'full' : 'active',
            addressType
          })
        } catch (error) {
          // Provider cooldowns already pace repeated network attempts. Do not add a second
          // five-minute lockout after a failed refresh, otherwise an explicit retry keeps
          // returning the same stale UTXO projection even after another endpoint recovers.
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
        if (!cached) throw new Error('Bitcoin discovery refresh was not persisted atomically')
      }
    }
    const result = await this.options.scanner.scan({
      keyDomainId: context.chainAccount.scope.keyDomainId,
      chainId: context.chainAccount.scope.chainId,
      accountIndex: context.accountIndex,
      targets,
      ...(importedPrivateKey ||
      (this.options.targets === undefined &&
        !ledgerAccount &&
        (cached === null || cached.checkpoint.maximumAddressesPerTarget === 1))
        ? { gapLimit: 1, maximumAddressesPerTarget: 1, fixedAddressCountPerTarget: 1 }
        : {
            ...(ledgerAccount && cached !== null
              ? { gapLimit: cached.checkpoint.gapLimit }
              : this.options.gapLimit === undefined
                ? {}
                : { gapLimit: this.options.gapLimit }),
            ...(this.options.maximumAddressesPerTarget === undefined
              ? {}
              : { maximumAddressesPerTarget: this.options.maximumAddressesPerTarget })
          }),
      ...(cached === null ? {} : { checkpoint: cached.checkpoint }),
      addressType,
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
      throw new Error('Bitcoin discovery checkpoint was not persisted atomically')
    }
    const currentPointer = await this.options.storageRepository.getActivePointer()
    if (currentPointer?.generationId !== context.generationId) return null
    return persisted
  }

  private timestamp(): number {
    const value = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Bitcoin discovery progress timestamp')
    }
    return value
  }
}
