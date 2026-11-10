import { parseChainAccountId } from '@/core/accounts/domain'
import {
  type PearlAddressObservation,
  type PearlDiscoveryCheckpoint,
  isPearlAddressUsed
} from '@/core/chains/pearl'
import {
  accountKey,
  hasExactKeys,
  isFixedSingleAddressPearlCheckpoint,
  isRecord,
  parseCheckpoint,
  parseScope,
  parseTimestamp,
  sameJson,
  targetKey,
  type PearlDiscoveryScope,
  type PearlDiscoveryState,
  type StoredPearlObservationRecord,
  type StoredPearlScanRecord
} from './pearl-discovery-persistence-model'
import {
  addressKey,
  observationKey,
  parseObservation
} from './pearl-discovery-persistence-observation'

export function assertInitialProgress(
  checkpoint: PearlDiscoveryCheckpoint,
  observation: PearlAddressObservation
): void {
  const cursorIndex = checkpoint.cursors.findIndex(
    cursor => cursor.target.change === observation.derived.change
  )
  const cursor = checkpoint.cursors[cursorIndex]
  const used = isPearlAddressUsed(observation.activity)
  if (
    cursorIndex < 0 ||
    !cursor ||
    observation.derived.addressIndex !== 0 ||
    cursor.nextAddressIndex !== 1 ||
    cursor.consecutiveUnused !== (used ? 0 : 1) ||
    checkpoint.cursors.some((item, index) => index !== cursorIndex && item.nextAddressIndex !== 0)
  ) {
    throw new Error('Pearl discovery progress does not start at an empty target')
  }
}

export function assertProgressAdvance(
  previous: PearlDiscoveryCheckpoint,
  next: PearlDiscoveryCheckpoint,
  observation: PearlAddressObservation
): void {
  if (
    previous.chainId !== next.chainId ||
    previous.accountIndex !== next.accountIndex ||
    previous.gapLimit !== next.gapLimit ||
    previous.maximumAddressesPerTarget !== next.maximumAddressesPerTarget ||
    previous.cursors.length !== next.cursors.length
  ) {
    throw new Error('Pearl discovery progress changed its scan policy')
  }
  const cursorIndex = previous.cursors.findIndex(
    cursor => cursor.target.change === observation.derived.change
  )
  if (cursorIndex < 0) throw new Error('Pearl discovery progress target is missing')
  const previousCursor = previous.cursors[cursorIndex]
  const nextCursor = next.cursors[cursorIndex]
  if (previousCursor.complete) throw new Error('Completed Pearl discovery target cannot advance')
  const used = isPearlAddressUsed(observation.activity)
  const expectedUnused = used ? 0 : previousCursor.consecutiveUnused + 1
  const expectedComplete = isFixedSingleAddressPearlCheckpoint(next)
    ? nextCursor.nextAddressIndex === next.maximumAddressesPerTarget
    : expectedUnused === next.gapLimit
  if (
    targetKey(nextCursor.target) !== targetKey(previousCursor.target) ||
    observation.derived.change !== previousCursor.target.change ||
    observation.derived.addressIndex !== previousCursor.nextAddressIndex ||
    nextCursor.nextAddressIndex !== previousCursor.nextAddressIndex + 1 ||
    nextCursor.consecutiveUnused !== expectedUnused ||
    nextCursor.complete !== expectedComplete
  ) {
    throw new Error('Pearl discovery progress is not the next address for its target')
  }
  for (let index = 0; index < previous.cursors.length; index += 1) {
    if (index !== cursorIndex && !sameJson(previous.cursors[index], next.cursors[index])) {
      throw new Error('Pearl discovery progress changed an unrelated cursor')
    }
  }
}

export function assertPearlDiscoveryTargetExtension(
  previous: PearlDiscoveryCheckpoint,
  next: PearlDiscoveryCheckpoint,
  _observations: readonly PearlAddressObservation[] = []
): void {
  if (
    previous.chainId !== next.chainId ||
    previous.accountIndex !== next.accountIndex ||
    previous.gapLimit !== next.gapLimit ||
    previous.maximumAddressesPerTarget !== next.maximumAddressesPerTarget ||
    next.cursors.length <= previous.cursors.length
  ) {
    throw new Error('Pearl discovery target extension changed its scan policy')
  }
  for (let index = 0; index < previous.cursors.length; index += 1) {
    if (!sameJson(previous.cursors[index], next.cursors[index])) {
      throw new Error('Pearl discovery target extension changed an existing cursor')
    }
  }
  for (const cursor of next.cursors.slice(previous.cursors.length)) {
    if (cursor.nextAddressIndex !== 0 || cursor.consecutiveUnused !== 0 || cursor.complete) {
      throw new Error('Pearl discovery target extension must append empty cursors')
    }
  }
}

export function parseStoredScan(
  value: unknown,
  expectedScope: PearlDiscoveryScope
): StoredPearlScanRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainAccountId',
      'accountKey',
      'chainAccount',
      'accountIndex',
      'checkpoint',
      'updatedAt'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.chainAccountId !== 'string' ||
    typeof value.accountKey !== 'string'
  ) {
    throw new Error('Invalid persisted Pearl discovery scan')
  }
  const scope = parseScope({
    chainAccount: value.chainAccount as PearlDiscoveryScope['chainAccount'],
    accountIndex: value.accountIndex as PearlDiscoveryScope['accountIndex']
  })
  if (
    parseChainAccountId(value.chainAccountId) !== scope.chainAccount.id ||
    value.accountKey !== accountKey(scope.chainAccount.scope) ||
    !sameJson(scope, expectedScope)
  ) {
    throw new Error('Persisted Pearl discovery scope mismatch')
  }
  return Object.freeze({
    schemaVersion: 1,
    chainAccountId: scope.chainAccount.id,
    accountKey: value.accountKey,
    chainAccount: scope.chainAccount,
    accountIndex: scope.accountIndex,
    checkpoint: parseCheckpoint(value.checkpoint, scope),
    updatedAt: parseTimestamp(value.updatedAt)
  })
}

export function parseStoredObservation(
  value: unknown,
  scope: PearlDiscoveryScope
): StoredPearlObservationRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'observationKey',
      'chainAccountId',
      'accountKey',
      'addressKey',
      'observation'
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.observationKey !== 'string' ||
    typeof value.chainAccountId !== 'string' ||
    typeof value.accountKey !== 'string' ||
    typeof value.addressKey !== 'string'
  ) {
    throw new Error('Invalid persisted Pearl discovery observation record')
  }
  const observation = parseObservation(value.observation, scope)
  if (
    value.chainAccountId !== scope.chainAccount.id ||
    value.accountKey !== accountKey(scope.chainAccount.scope) ||
    value.observationKey !== observationKey(scope.chainAccount.id, observation) ||
    value.addressKey !== addressKey(scope.chainAccount.id, observation)
  ) {
    throw new Error('Persisted Pearl discovery observation index mismatch')
  }
  return Object.freeze({
    schemaVersion: 1,
    observationKey: value.observationKey,
    chainAccountId: value.chainAccountId,
    accountKey: value.accountKey,
    addressKey: value.addressKey,
    observation
  })
}

export function parseState(
  scanValue: unknown,
  observationValues: readonly unknown[],
  scope: PearlDiscoveryScope
): PearlDiscoveryState {
  const scan = parseStoredScan(scanValue, scope)
  const observations = observationValues.map(
    value => parseStoredObservation(value, scope).observation
  )
  const byCursor = new Map<string, Map<number, PearlAddressObservation>>()
  for (const observation of observations) {
    const key = targetKey(observation.derived)
    const indexes = byCursor.get(key) ?? new Map<number, PearlAddressObservation>()
    if (indexes.has(observation.derived.addressIndex)) {
      throw new Error('Duplicate persisted Pearl discovery address index')
    }
    indexes.set(observation.derived.addressIndex, observation)
    byCursor.set(key, indexes)
  }
  const sorted: PearlAddressObservation[] = []
  for (const cursor of scan.checkpoint.cursors) {
    const key = targetKey(cursor.target)
    const values = byCursor.get(key) ?? new Map<number, PearlAddressObservation>()
    if (values.size !== cursor.nextAddressIndex) {
      throw new Error('Persisted Pearl discovery observations do not match the checkpoint')
    }
    for (let index = 0; index < cursor.nextAddressIndex; index += 1) {
      const observation = values.get(index)
      if (!observation) throw new Error('Persisted Pearl discovery contains an address gap')
      sorted.push(observation)
    }
    byCursor.delete(key)
  }
  if (byCursor.size > 0) {
    throw new Error('Persisted Pearl discovery contains an unknown target')
  }
  return Object.freeze({
    chainAccount: scope.chainAccount,
    accountIndex: scope.accountIndex,
    checkpoint: scan.checkpoint,
    observations: Object.freeze(sorted),
    updatedAt: scan.updatedAt
  })
}
