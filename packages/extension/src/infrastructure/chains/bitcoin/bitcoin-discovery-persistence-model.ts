import {
  parseAccountId,
  parseAccountIndex,
  type AccountId,
  type AccountIndex,
  type ChainAccount
} from '@/core/accounts/domain'
import {
  BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
  BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET,
  BITCOIN_MAXIMUM_GAP_LIMIT,
  parseSupportedBitcoinAddress,
  type BitcoinAddressObservation,
  type BitcoinDiscoveryCheckpoint
} from '@/core/chains/bitcoin'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import { parseStorageV2ChainAccount } from '@/infrastructure/persistence/schema'

export interface BitcoinDiscoveryScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
}

export interface BitcoinDiscoveryState extends BitcoinDiscoveryScope {
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly observations: readonly BitcoinAddressObservation[]
  readonly updatedAt: number
}

export interface BitcoinDiscoveryProgress extends BitcoinDiscoveryScope {
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly observation: BitcoinAddressObservation
  readonly updatedAt: number
}

export interface BitcoinDiscoveryRefresh extends BitcoinDiscoveryScope {
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly observations: readonly BitcoinAddressObservation[]
  readonly updatedAt: number
}

export interface BitcoinDiscoveryTargetExtension extends BitcoinDiscoveryScope {
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly updatedAt: number
}

export interface BitcoinDiscoveryRepository {
  get(scope: BitcoinDiscoveryScope): Promise<BitcoinDiscoveryState | null>
  putProgress(progress: BitcoinDiscoveryProgress): Promise<void>
  putRefresh(refresh: BitcoinDiscoveryRefresh): Promise<void>
  extendTargets(extension: BitcoinDiscoveryTargetExtension): Promise<void>
  deleteByAccountScope(scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }): Promise<number>
}

export function bitcoinChainAccountsMatch(left: ChainAccount, right: ChainAccount): boolean {
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

export interface StoredScanRecord {
  readonly schemaVersion: 1
  readonly chainAccountId: string
  readonly accountKey: string
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly updatedAt: number
}

export interface StoredObservationRecord {
  readonly schemaVersion: 1
  readonly observationKey: string
  readonly chainAccountId: string
  readonly accountKey: string
  readonly addressKey: string
  readonly observation: BitcoinAddressObservation
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
  return parseSafeInteger(value, 'Bitcoin discovery timestamp')
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
    throw new Error('Invalid Bitcoin discovery Account scope')
  }
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

export function parseScope(value: unknown): BitcoinDiscoveryScope {
  if (!isRecord(value) || !hasExactKeys(value, ['chainAccount', 'accountIndex'])) {
    throw new Error('Invalid Bitcoin discovery scope')
  }
  const chainAccount = parseStorageV2ChainAccount(value.chainAccount)
  const accountIndex = parseAccountIndex(value.accountIndex)
  const chainId = parseChainId(chainAccount.scope.chainId).id
  if (
    chainId !== 'bip122:000000000019d6689c085ae165831e93' &&
    chainId !== 'bip122:000000000933ea01ad0ee984209779ba'
  ) {
    throw new Error('Bitcoin discovery scope requires a supported Bitcoin ChainAccount')
  }
  const coinType = chainId === 'bip122:000000000019d6689c085ae165831e93' ? 0 : 1
  const deviceAccount = new RegExp(`^m/84'/${coinType}'/(0|[1-9][0-9]*)'/0/0$`).exec(
    chainAccount.derivation.path
  )
  const isHd =
    chainAccount.derivation.scheme === 'bip84' &&
    deviceAccount !== null &&
    Number(deviceAccount[1]) <= 0x7fffffff
  const isImported =
    chainAccount.derivation.scheme === 'imported' &&
    chainAccount.derivation.path === 'm' &&
    accountIndex === 0
  if ((!isHd && !isImported) || chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Bitcoin discovery scope does not match bitcoin-mainstream-v1')
  }
  parseSupportedBitcoinAddress(chainAccount.identity.value, chainId, 'p2wpkh')
  return Object.freeze({ chainAccount, accountIndex })
}

function parseTarget(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['addressType', 'change']) ||
    (value.addressType !== 'p2pkh' &&
      value.addressType !== 'p2sh-p2wpkh' &&
      value.addressType !== 'p2wpkh' &&
      value.addressType !== 'p2tr') ||
    typeof value.change !== 'boolean'
  ) {
    throw new Error('Invalid Bitcoin discovery target')
  }
  return Object.freeze({ addressType: value.addressType, change: value.change })
}

export function targetKey(target: {
  readonly addressType: string
  readonly change: boolean
}): string {
  return `${target.addressType}:${target.change ? 'change' : 'receive'}`
}

export function isFixedSingleAddressBitcoinCheckpoint(
  checkpoint: Pick<BitcoinDiscoveryCheckpoint, 'gapLimit' | 'maximumAddressesPerTarget'>
): boolean {
  return checkpoint.gapLimit === 1 && checkpoint.maximumAddressesPerTarget === 1
}

export function parseCheckpoint(
  value: unknown,
  scope: BitcoinDiscoveryScope
): BitcoinDiscoveryCheckpoint {
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
    value.schemaVersion !== BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION ||
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.accountIndex !== scope.accountIndex ||
    !Array.isArray(value.cursors) ||
    value.cursors.length === 0 ||
    value.cursors.length > 8
  ) {
    throw new Error('Invalid Bitcoin discovery checkpoint')
  }
  const gapLimit = parseSafeInteger(
    value.gapLimit,
    'Bitcoin discovery gap limit',
    BITCOIN_MAXIMUM_GAP_LIMIT
  )
  if (gapLimit === 0) throw new Error('Bitcoin discovery gap limit must be positive')
  const maximumAddressesPerTarget = parseSafeInteger(
    value.maximumAddressesPerTarget,
    'Bitcoin discovery address limit',
    BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET
  )
  if (maximumAddressesPerTarget < gapLimit) {
    throw new Error('Bitcoin discovery address limit must cover its gap limit')
  }
  const fixedSingleAddress = isFixedSingleAddressBitcoinCheckpoint({
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
      throw new Error('Invalid Bitcoin discovery cursor')
    }
    const target = parseTarget(cursorValue.target)
    const key = targetKey(target)
    if (seenTargets.has(key)) throw new Error('Duplicate Bitcoin discovery target')
    seenTargets.add(key)
    const nextAddressIndex = parseSafeInteger(
      cursorValue.nextAddressIndex,
      'Bitcoin discovery next address index',
      maximumAddressesPerTarget
    )
    const consecutiveUnused = parseSafeInteger(
      cursorValue.consecutiveUnused,
      'Bitcoin discovery consecutive unused count',
      gapLimit
    )
    const expectedComplete = fixedSingleAddress
      ? nextAddressIndex === maximumAddressesPerTarget
      : consecutiveUnused === gapLimit
    if (consecutiveUnused > nextAddressIndex || cursorValue.complete !== expectedComplete) {
      throw new Error('Inconsistent Bitcoin discovery cursor')
    }
    return Object.freeze({
      target,
      nextAddressIndex,
      consecutiveUnused,
      complete: cursorValue.complete
    })
  })
  if (scope.chainAccount.derivation.scheme === 'imported') {
    const expectedTargets = [
      'p2wpkh:receive',
      'p2tr:receive',
      'p2pkh:receive',
      'p2sh-p2wpkh:receive'
    ]
    if (
      gapLimit !== 1 ||
      maximumAddressesPerTarget !== 1 ||
      cursors.length !== expectedTargets.length ||
      cursors.some((cursor, index) => targetKey(cursor.target) !== expectedTargets[index])
    ) {
      throw new Error('Imported Bitcoin discovery checkpoint does not match its fixed addresses')
    }
  }
  return Object.freeze({
    schemaVersion: BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
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
