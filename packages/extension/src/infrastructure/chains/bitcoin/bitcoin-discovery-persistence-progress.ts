import { parseChainAccountId } from '@/core/accounts/domain'
import {
  BITCOIN_MAXIMUM_GAP_LIMIT,
  type BitcoinAddressObservation,
  type BitcoinDiscoveryCheckpoint
} from '@/core/chains/bitcoin'
import {
  accountKey,
  hasExactKeys,
  isFixedSingleAddressBitcoinCheckpoint,
  isRecord,
  parseCheckpoint,
  parseScope,
  parseTimestamp,
  sameJson,
  targetKey,
  type BitcoinDiscoveryScope,
  type BitcoinDiscoveryState,
  type StoredObservationRecord,
  type StoredScanRecord
} from './bitcoin-discovery-persistence-model'
import {
  addressKey,
  observationKey,
  parseObservation
} from './bitcoin-discovery-persistence-observation'

export function assertInitialProgress(
  checkpoint: BitcoinDiscoveryCheckpoint,
  observation: BitcoinAddressObservation
): void {
  const cursorIndex = checkpoint.cursors.findIndex(
    cursor =>
      cursor.target.addressType === observation.derived.addressType &&
      cursor.target.change === observation.derived.change
  )
  const cursor = checkpoint.cursors[cursorIndex]
  if (
    cursorIndex < 0 ||
    !cursor ||
    observation.derived.addressIndex !== 0 ||
    cursor.nextAddressIndex !== 1 ||
    cursor.consecutiveUnused !== (observation.activity.used ? 0 : 1) ||
    checkpoint.cursors.some((item, index) => index !== cursorIndex && item.nextAddressIndex !== 0)
  ) {
    throw new Error('Bitcoin discovery progress does not start at an empty target')
  }
}

export function assertProgressAdvance(
  previous: BitcoinDiscoveryCheckpoint,
  next: BitcoinDiscoveryCheckpoint,
  observation: BitcoinAddressObservation
): void {
  if (
    previous.chainId !== next.chainId ||
    previous.accountIndex !== next.accountIndex ||
    previous.gapLimit !== next.gapLimit ||
    previous.maximumAddressesPerTarget !== next.maximumAddressesPerTarget ||
    previous.cursors.length !== next.cursors.length
  ) {
    throw new Error('Bitcoin discovery progress changed its scan policy')
  }
  const cursorIndex = previous.cursors.findIndex(
    cursor =>
      cursor.target.addressType === observation.derived.addressType &&
      cursor.target.change === observation.derived.change
  )
  if (cursorIndex < 0) throw new Error('Bitcoin discovery progress target is missing')
  const previousCursor = previous.cursors[cursorIndex]
  const nextCursor = next.cursors[cursorIndex]
  if (previousCursor.complete) throw new Error('Completed Bitcoin discovery target cannot advance')
  const expectedUnused = observation.activity.used ? 0 : previousCursor.consecutiveUnused + 1
  const expectedComplete = isFixedSingleAddressBitcoinCheckpoint(next)
    ? nextCursor.nextAddressIndex === next.maximumAddressesPerTarget
    : expectedUnused === next.gapLimit
  if (
    targetKey(nextCursor.target) !== targetKey(previousCursor.target) ||
    observation.derived.addressType !== previousCursor.target.addressType ||
    observation.derived.change !== previousCursor.target.change ||
    observation.derived.addressIndex !== previousCursor.nextAddressIndex ||
    nextCursor.nextAddressIndex !== previousCursor.nextAddressIndex + 1 ||
    nextCursor.consecutiveUnused !== expectedUnused ||
    nextCursor.complete !== expectedComplete
  ) {
    throw new Error('Bitcoin discovery progress is not the next address for its target')
  }
  for (let index = 0; index < previous.cursors.length; index += 1) {
    if (index !== cursorIndex && !sameJson(previous.cursors[index], next.cursors[index])) {
      throw new Error('Bitcoin discovery progress changed an unrelated cursor')
    }
  }
}

export function assertBitcoinDiscoveryTargetExtension(
  previous: BitcoinDiscoveryCheckpoint,
  next: BitcoinDiscoveryCheckpoint,
  observations: readonly BitcoinAddressObservation[] = []
): void {
  if (isFixedSingleAddressBitcoinCheckpoint(previous) && next.maximumAddressesPerTarget > 1) {
    if (
      previous.chainId !== next.chainId ||
      previous.accountIndex !== next.accountIndex ||
      previous.cursors.length < 1 ||
      previous.cursors.length > 2 ||
      next.cursors.length !== 2 ||
      next.maximumAddressesPerTarget < next.gapLimit ||
      next.cursors.some(
        (cursor, index) =>
          cursor.target.addressType !== 'p2wpkh' || cursor.target.change !== (index === 1)
      )
    ) {
      throw new Error('Bitcoin discovery target extension changed its scan policy')
    }
    for (let index = 0; index < previous.cursors.length; index += 1) {
      const cursor = previous.cursors[index]
      const observation = observations.find(
        item =>
          item.derived.addressType === cursor.target.addressType &&
          item.derived.change === cursor.target.change &&
          item.derived.addressIndex === 0
      )
      const empty = cursor.nextAddressIndex === 0
      if (empty) {
        if (
          observation ||
          cursor.consecutiveUnused !== 0 ||
          cursor.complete ||
          next.cursors[index].nextAddressIndex !== 0 ||
          next.cursors[index].consecutiveUnused !== 0 ||
          next.cursors[index].complete
        ) {
          throw new Error('Bitcoin discovery target extension changed an existing cursor')
        }
        continue
      }
      if (
        cursor.nextAddressIndex !== 1 ||
        !observation ||
        next.cursors[index].nextAddressIndex !== 1 ||
        next.cursors[index].consecutiveUnused !== (observation.activity.used ? 0 : 1) ||
        next.cursors[index].complete !== (!observation.activity.used && next.gapLimit === 1)
      ) {
        throw new Error('Bitcoin discovery target extension changed an existing cursor')
      }
    }
    if (
      previous.cursors.length === 1 &&
      (next.cursors[1].nextAddressIndex !== 0 ||
        next.cursors[1].consecutiveUnused !== 0 ||
        next.cursors[1].complete)
    ) {
      throw new Error('Bitcoin discovery target extension must append an empty cursor')
    }
    return
  }
  if (
    next.gapLimit > previous.gapLimit &&
    previous.maximumAddressesPerTarget > 1 &&
    previous.cursors.length === 2 &&
    previous.cursors.every(
      (cursor, index) =>
        cursor.target.addressType === 'p2wpkh' && cursor.target.change === (index === 1)
    ) &&
    previous.chainId === next.chainId &&
    previous.accountIndex === next.accountIndex &&
    previous.maximumAddressesPerTarget === next.maximumAddressesPerTarget &&
    next.gapLimit <= BITCOIN_MAXIMUM_GAP_LIMIT &&
    next.cursors.length === previous.cursors.length &&
    next.cursors.every((cursor, index) => {
      const prior = previous.cursors[index]
      return (
        targetKey(cursor.target) === targetKey(prior.target) &&
        cursor.nextAddressIndex === prior.nextAddressIndex &&
        cursor.consecutiveUnused === prior.consecutiveUnused &&
        cursor.complete === (cursor.consecutiveUnused === next.gapLimit)
      )
    })
  )
    return
  if (
    previous.chainId !== next.chainId ||
    previous.accountIndex !== next.accountIndex ||
    previous.gapLimit !== next.gapLimit ||
    previous.maximumAddressesPerTarget !== next.maximumAddressesPerTarget ||
    next.cursors.length <= previous.cursors.length
  ) {
    throw new Error('Bitcoin discovery target extension changed its scan policy')
  }
  for (let index = 0; index < previous.cursors.length; index += 1) {
    if (!sameJson(previous.cursors[index], next.cursors[index])) {
      throw new Error('Bitcoin discovery target extension changed an existing cursor')
    }
  }
  for (const cursor of next.cursors.slice(previous.cursors.length)) {
    if (cursor.nextAddressIndex !== 0 || cursor.consecutiveUnused !== 0 || cursor.complete) {
      throw new Error('Bitcoin discovery target extension must append empty cursors')
    }
  }
}

export function parseStoredScan(
  value: unknown,
  expectedScope: BitcoinDiscoveryScope
): StoredScanRecord {
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
    throw new Error('Invalid persisted Bitcoin discovery scan')
  }
  const scope = parseScope({
    chainAccount: value.chainAccount as BitcoinDiscoveryScope['chainAccount'],
    accountIndex: value.accountIndex as BitcoinDiscoveryScope['accountIndex']
  })
  if (
    parseChainAccountId(value.chainAccountId) !== scope.chainAccount.id ||
    value.accountKey !== accountKey(scope.chainAccount.scope) ||
    !sameJson(scope, expectedScope)
  ) {
    throw new Error('Persisted Bitcoin discovery scope mismatch')
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
  scope: BitcoinDiscoveryScope
): StoredObservationRecord {
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
    throw new Error('Invalid persisted Bitcoin discovery observation record')
  }
  const observation = parseObservation(value.observation, scope)
  if (
    value.chainAccountId !== scope.chainAccount.id ||
    value.accountKey !== accountKey(scope.chainAccount.scope) ||
    value.observationKey !== observationKey(scope.chainAccount.id, observation) ||
    value.addressKey !== addressKey(scope.chainAccount.id, observation)
  ) {
    throw new Error('Persisted Bitcoin discovery observation index mismatch')
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
  scope: BitcoinDiscoveryScope
): BitcoinDiscoveryState {
  const scan = parseStoredScan(scanValue, scope)
  const observations = observationValues.map(
    value => parseStoredObservation(value, scope).observation
  )
  const byCursor = new Map<string, Map<number, BitcoinAddressObservation>>()
  for (const observation of observations) {
    const key = targetKey(observation.derived)
    const indexes = byCursor.get(key) ?? new Map<number, BitcoinAddressObservation>()
    if (indexes.has(observation.derived.addressIndex)) {
      throw new Error('Duplicate persisted Bitcoin discovery address index')
    }
    indexes.set(observation.derived.addressIndex, observation)
    byCursor.set(key, indexes)
  }
  const sorted: BitcoinAddressObservation[] = []
  for (const cursor of scan.checkpoint.cursors) {
    const key = targetKey(cursor.target)
    const values = byCursor.get(key) ?? new Map<number, BitcoinAddressObservation>()
    if (values.size !== cursor.nextAddressIndex) {
      throw new Error('Persisted Bitcoin discovery observations do not match the checkpoint')
    }
    for (let index = 0; index < cursor.nextAddressIndex; index += 1) {
      const observation = values.get(index)
      if (!observation) throw new Error('Persisted Bitcoin discovery contains an address gap')
      sorted.push(observation)
    }
    byCursor.delete(key)
  }
  if (byCursor.size > 0) {
    throw new Error('Persisted Bitcoin discovery contains an unknown target')
  }
  return Object.freeze({
    chainAccount: scope.chainAccount,
    accountIndex: scope.accountIndex,
    checkpoint: scan.checkpoint,
    observations: Object.freeze(sorted),
    updatedAt: scan.updatedAt
  })
}
