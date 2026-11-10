import {
  PEARL_MAXIMUM_ADDRESSES_PER_TARGET,
  isPearlAddressUsed,
  parseSupportedPearlAddress,
  type PearlAddressObservation,
  type PearlTransactionStatus,
  type PearlUtxo,
  type DerivedPearlAddress
} from '@/core/chains/pearl'
import { getPearlChainId } from '@/core/chains/registry'
import {
  hasExactKeys,
  isRecord,
  type PearlDiscoveryScope
} from './pearl-discovery-persistence-model'

const MAXIMUM_UTXOS_PER_ADDRESS = 10_000
const MAXIMUM_PEARL_SUPPLY_SATS = 2_100_000_000_000_000n

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

function parseTransactionStatus(value: unknown): PearlTransactionStatus {
  if (!isRecord(value) || typeof value.confirmed !== 'boolean') {
    throw new Error('Invalid persisted Pearl transaction status')
  }
  if (!value.confirmed) {
    if (
      !hasExactKeys(value, ['confirmed']) ||
      value.blockHeight !== undefined ||
      value.blockHash !== undefined ||
      value.blockTime !== undefined
    ) {
      throw new Error('Unconfirmed Pearl transaction status contains block data')
    }
    return Object.freeze({ confirmed: false })
  }
  if (!hasExactKeys(value, ['confirmed', 'blockHeight'], ['blockHash', 'blockTime'])) {
    throw new Error('Invalid persisted Pearl confirmed transaction status')
  }
  if (
    value.blockHash !== undefined &&
    (typeof value.blockHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.blockHash))
  ) {
    throw new Error('Invalid persisted Pearl block hash')
  }
  return Object.freeze({
    confirmed: true,
    blockHeight: parseSafeInteger(
      value.blockHeight,
      'Pearl transaction block height',
      2_147_483_647
    ),
    ...(value.blockHash === undefined ? {} : { blockHash: value.blockHash }),
    ...(value.blockTime === undefined
      ? {}
      : { blockTime: parseSafeInteger(value.blockTime, 'Pearl transaction block time') })
  })
}

function parseUtxo(value: unknown, expectedAddress: string): PearlUtxo {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['transactionId', 'outputIndex', 'valueSats', 'address', 'status']) ||
    typeof value.transactionId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.transactionId) ||
    typeof value.valueSats !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.valueSats) ||
    BigInt(value.valueSats) > MAXIMUM_PEARL_SUPPLY_SATS ||
    value.address !== expectedAddress
  ) {
    throw new Error('Invalid persisted Pearl UTXO')
  }
  return Object.freeze({
    transactionId: value.transactionId,
    outputIndex: parseSafeInteger(value.outputIndex, 'Pearl UTXO output index', 0xffffffff),
    valueSats: value.valueSats,
    address: expectedAddress,
    status: parseTransactionStatus(value.status)
  })
}

function parseDerivedAddress(value: unknown, scope: PearlDiscoveryScope): DerivedPearlAddress {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'chainId',
      'address',
      'accountIndex',
      'change',
      'addressIndex',
      'derivationPath',
      'publicKey',
      'masterFingerprint',
      'scriptPubKey',
      'addressScheme',
      'derivationScheme'
    ]) ||
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.accountIndex !== scope.accountIndex ||
    typeof value.change !== 'boolean' ||
    value.addressScheme !== 'pearl_p2tr' ||
    (value.derivationScheme !== 'bip86' && value.derivationScheme !== 'imported') ||
    typeof value.publicKey !== 'string' ||
    !/^0x0[23][0-9a-f]{64}$/.test(value.publicKey) ||
    typeof value.masterFingerprint !== 'string' ||
    !/^0x[0-9a-f]{8}$/.test(value.masterFingerprint) ||
    typeof value.scriptPubKey !== 'string' ||
    !/^0x5120[0-9a-f]{64}$/.test(value.scriptPubKey)
  ) {
    throw new Error('Invalid persisted Pearl derived address')
  }
  const addressIndex = parseSafeInteger(
    value.addressIndex,
    'Pearl derived address index',
    PEARL_MAXIMUM_ADDRESSES_PER_TARGET - 1
  )
  const coinType = scope.chainAccount.scope.chainId === getPearlChainId('mainnet') ? 808276 : 1
  const imported = scope.chainAccount.derivation.scheme === 'imported'
  const expectedPath = imported
    ? 'm'
    : `m/86'/${coinType}'/${scope.accountIndex}'/${value.change ? 1 : 0}/${addressIndex}`
  if (
    value.derivationScheme !== (imported ? 'imported' : 'bip86') ||
    value.derivationPath !== expectedPath ||
    (imported && (value.change || addressIndex !== 0 || scope.accountIndex !== 0))
  ) {
    throw new Error('Persisted Pearl derived address metadata does not match its path')
  }
  return Object.freeze({
    chainId: scope.chainAccount.scope.chainId,
    address: parseSupportedPearlAddress(value.address as string, scope.chainAccount.scope.chainId),
    accountIndex: scope.accountIndex,
    change: value.change,
    addressIndex,
    derivationPath: expectedPath,
    publicKey: value.publicKey,
    masterFingerprint: value.masterFingerprint,
    scriptPubKey: value.scriptPubKey,
    addressScheme: 'pearl_p2tr',
    derivationScheme: imported ? 'imported' : 'bip86'
  })
}

export function parseObservation(
  value: unknown,
  scope: PearlDiscoveryScope
): PearlAddressObservation {
  if (!isRecord(value) || !hasExactKeys(value, ['derived', 'activity', 'utxos'])) {
    throw new Error('Invalid persisted Pearl address observation')
  }
  const derived = parseDerivedAddress(value.derived, scope)
  if (
    !isRecord(value.activity) ||
    !hasExactKeys(value.activity, [
      'confirmedTransactionCount',
      'mempoolTransactionCount',
      'used',
      'balanceSats'
    ]) ||
    typeof value.activity.used !== 'boolean' ||
    typeof value.activity.balanceSats !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.activity.balanceSats)
  ) {
    throw new Error('Invalid persisted Pearl address activity')
  }
  const confirmedTransactionCount = parseSafeInteger(
    value.activity.confirmedTransactionCount,
    'Pearl address confirmed transaction count'
  )
  const mempoolTransactionCount = parseSafeInteger(
    value.activity.mempoolTransactionCount,
    'Pearl address mempool transaction count'
  )
  const expectedUsed =
    confirmedTransactionCount + mempoolTransactionCount > 0 || value.activity.balanceSats !== '0'
  if (value.activity.used !== expectedUsed) {
    throw new Error('Persisted Pearl address activity is inconsistent')
  }
  const activity = Object.freeze({
    confirmedTransactionCount,
    mempoolTransactionCount,
    used: value.activity.used,
    balanceSats: value.activity.balanceSats
  })
  if (!Array.isArray(value.utxos) || value.utxos.length > MAXIMUM_UTXOS_PER_ADDRESS) {
    throw new Error('Invalid persisted Pearl UTXO inventory')
  }
  const seenUtxos = new Set<string>()
  const utxos = value.utxos.map(utxoValue => {
    const utxo = parseUtxo(utxoValue, derived.address)
    const key = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seenUtxos.has(key)) throw new Error('Duplicate persisted Pearl UTXO')
    seenUtxos.add(key)
    return utxo
  })
  if (!isPearlAddressUsed(activity) && utxos.length > 0) {
    throw new Error('Unused Pearl address cannot contain UTXOs')
  }
  return Object.freeze({
    derived,
    activity,
    utxos: Object.freeze(utxos)
  })
}

export function observationKey(
  chainAccountId: string,
  observation: PearlAddressObservation
): string {
  return JSON.stringify([
    chainAccountId,
    observation.derived.change,
    observation.derived.addressIndex
  ])
}

export function addressKey(chainAccountId: string, observation: PearlAddressObservation): string {
  return JSON.stringify([chainAccountId, observation.derived.address])
}
