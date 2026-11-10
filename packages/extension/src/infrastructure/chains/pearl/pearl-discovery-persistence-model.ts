import {
  parseAccountId,
  parseAccountIndex,
  type AccountId,
  type AccountIndex,
  type ChainAccount
} from '@/core/accounts/domain'
import {
  PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
  PEARL_MAXIMUM_ADDRESSES_PER_TARGET,
  PEARL_MAXIMUM_GAP_LIMIT,
  parseSupportedPearlAddress,
  type PearlAddressObservation,
  type PearlDiscoveryCheckpoint
} from '@/core/chains/pearl'
import { getPearlChainId, parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import { parseStorageV2ChainAccount } from '@/infrastructure/persistence/schema'

export interface PearlDiscoveryScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
}

export interface PearlDiscoveryState extends PearlDiscoveryScope {
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly observations: readonly PearlAddressObservation[]
  readonly updatedAt: number
}

export interface PearlDiscoveryProgress extends PearlDiscoveryScope {
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly observation: PearlAddressObservation
  readonly updatedAt: number
}

export interface PearlDiscoveryRefresh extends PearlDiscoveryScope {
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly observations: readonly PearlAddressObservation[]
  readonly updatedAt: number
}

export interface PearlDiscoveryTargetExtension extends PearlDiscoveryScope {
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly updatedAt: number
}

export interface PearlDiscoveryRepository {
  get(scope: PearlDiscoveryScope): Promise<PearlDiscoveryState | null>
  putProgress(progress: PearlDiscoveryProgress): Promise<void>
  putRefresh(refresh: PearlDiscoveryRefresh): Promise<void>
  extendTargets(extension: PearlDiscoveryTargetExtension): Promise<void>
  deleteByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number>
}

export function pearlChainAccountsMatch(left: ChainAccount, right: ChainAccount): boolean {
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

export interface StoredPearlScanRecord {
  readonly schemaVersion: 1
  readonly chainAccountId: string
  readonly accountKey: string
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly updatedAt: number
}

export interface StoredPearlObservationRecord {
  readonly schemaVersion: 1
  readonly observationKey: string
  readonly chainAccountId: string
  readonly accountKey: string
  readonly addressKey: string
  readonly observation: PearlAddressObservation
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function parseSafeInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

export function parseTimestamp(value: unknown): number {
  return parseSafeInteger(value, 'Pearl discovery timestamp')
}

export function accountKey(scope: {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}): string {
  return JSON.stringify([scope.keyDomainId, scope.accountId])
}

export function parseAccountScope(value: unknown): {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
} {
  if (!isRecord(value) || !hasExactKeys(value, ['keyDomainId', 'accountId'])) {
    throw new Error('Invalid Pearl discovery Account scope')
  }
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

export function parseScope(value: unknown): PearlDiscoveryScope {
  if (!isRecord(value) || !hasExactKeys(value, ['chainAccount', 'accountIndex'])) {
    throw new Error('Invalid Pearl discovery scope')
  }
  const chainAccount = parseStorageV2ChainAccount(value.chainAccount)
  const accountIndex = parseAccountIndex(value.accountIndex)
  const chainId = parseChainId(chainAccount.scope.chainId).id
  if (chainId !== getPearlChainId('mainnet') && chainId !== getPearlChainId('testnet')) {
    throw new Error('Pearl discovery scope requires a supported Pearl ChainAccount')
  }
  const coinType = chainId === getPearlChainId('mainnet') ? 808276 : 1
  const deviceAccount = new RegExp(`^m/86'/${coinType}'/(0|[1-9][0-9]*)'/0/0$`).exec(
    chainAccount.derivation.path
  )
  const isHd =
    chainAccount.derivation.scheme === 'bip86' &&
    deviceAccount !== null &&
    Number(deviceAccount[1]) <= 0x7fffffff
  const isImported =
    chainAccount.derivation.scheme === 'imported' &&
    chainAccount.derivation.path === 'm' &&
    accountIndex === 0
  if ((!isHd && !isImported) || chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Pearl discovery scope does not match pearl_p2tr')
  }
  parseSupportedPearlAddress(chainAccount.identity.value, chainId)
  return Object.freeze({ chainAccount, accountIndex })
}

function parseTarget(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, ['change']) || typeof value.change !== 'boolean') {
    throw new Error('Invalid Pearl discovery target')
  }
  return Object.freeze({ change: value.change })
}

export function targetKey(target: { readonly change: boolean }): string {
  return target.change ? 'change' : 'receive'
}

export function isFixedSingleAddressPearlCheckpoint(
  checkpoint: Pick<PearlDiscoveryCheckpoint, 'gapLimit' | 'maximumAddressesPerTarget'>
): boolean {
  return checkpoint.gapLimit === 1 && checkpoint.maximumAddressesPerTarget === 1
}

export function parseCheckpoint(
  value: unknown,
  scope: PearlDiscoveryScope
): PearlDiscoveryCheckpoint {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainId',
      'accountIndex',
      'gapLimit',
      'maximumAddressesPerTarget',
      'cursors'
    ]) ||
    value.schemaVersion !== PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION ||
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.accountIndex !== scope.accountIndex ||
    !Array.isArray(value.cursors) ||
    value.cursors.length === 0 ||
    value.cursors.length > 2
  ) {
    throw new Error('Invalid Pearl discovery checkpoint')
  }
  const gapLimit = parseSafeInteger(
    value.gapLimit,
    'Pearl discovery gap limit',
    PEARL_MAXIMUM_GAP_LIMIT
  )
  if (gapLimit === 0) throw new Error('Pearl discovery gap limit must be positive')
  const maximumAddressesPerTarget = parseSafeInteger(
    value.maximumAddressesPerTarget,
    'Pearl discovery address limit',
    PEARL_MAXIMUM_ADDRESSES_PER_TARGET
  )
  if (maximumAddressesPerTarget < gapLimit) {
    throw new Error('Pearl discovery address limit must cover its gap limit')
  }
  const fixedSingleAddress = isFixedSingleAddressPearlCheckpoint({
    gapLimit,
    maximumAddressesPerTarget
  })
  const seenTargets = new Set<string>()
  const cursors = value.cursors.map(cursorValue => {
    if (
      !isRecord(cursorValue) ||
      !hasExactKeys(cursorValue, ['target', 'nextAddressIndex', 'consecutiveUnused', 'complete']) ||
      typeof cursorValue.complete !== 'boolean'
    ) {
      throw new Error('Invalid Pearl discovery cursor')
    }
    const target = parseTarget(cursorValue.target)
    const key = targetKey(target)
    if (seenTargets.has(key)) throw new Error('Duplicate Pearl discovery target')
    seenTargets.add(key)
    const nextAddressIndex = parseSafeInteger(
      cursorValue.nextAddressIndex,
      'Pearl discovery next address index',
      maximumAddressesPerTarget
    )
    const consecutiveUnused = parseSafeInteger(
      cursorValue.consecutiveUnused,
      'Pearl discovery consecutive unused count',
      gapLimit
    )
    const expectedComplete = fixedSingleAddress
      ? nextAddressIndex === maximumAddressesPerTarget
      : consecutiveUnused === gapLimit
    if (consecutiveUnused > nextAddressIndex || cursorValue.complete !== expectedComplete) {
      throw new Error('Inconsistent Pearl discovery cursor')
    }
    return Object.freeze({
      target,
      nextAddressIndex,
      consecutiveUnused,
      complete: cursorValue.complete
    })
  })
  if (scope.chainAccount.derivation.scheme === 'imported') {
    if (
      gapLimit !== 1 ||
      maximumAddressesPerTarget !== 1 ||
      cursors.length !== 1 ||
      targetKey(cursors[0].target) !== 'receive'
    ) {
      throw new Error('Imported Pearl discovery checkpoint does not match its fixed address')
    }
  }
  return Object.freeze({
    schemaVersion: PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
    chainId: scope.chainAccount.scope.chainId,
    accountIndex: scope.accountIndex,
    gapLimit,
    maximumAddressesPerTarget,
    cursors: Object.freeze(cursors)
  })
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
