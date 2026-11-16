import {
  BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET,
  parseSupportedBitcoinAddress,
  type BitcoinAddressObservation,
  type BitcoinTransactionStatus,
  type BitcoinUtxo,
  type DerivedBitcoinAddress
} from '@/core/chains/bitcoin'
import {
  hasExactKeys,
  isRecord,
  type BitcoinDiscoveryScope
} from './bitcoin-discovery-persistence-model'

const MAXIMUM_UTXOS_PER_ADDRESS = 10_000
const MAXIMUM_BITCOIN_SUPPLY_SATS = 2_100_000_000_000_000n

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

function parseOptionalMasterFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) {
    throw new Error('Invalid persisted Bitcoin master fingerprint')
  }
  return value
}

function parseOptionalScript(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(value)) {
    throw new Error(`Invalid persisted Bitcoin ${label}`)
  }
  return value
}

function parseTransactionStatus(value: unknown): BitcoinTransactionStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['confirmed'], ['blockHeight', 'blockHash', 'blockTime']) ||
    typeof value.confirmed !== 'boolean'
  ) {
    throw new Error('Invalid persisted Bitcoin transaction status')
  }
  if (!value.confirmed) {
    if (
      value.blockHeight !== undefined ||
      value.blockHash !== undefined ||
      value.blockTime !== undefined
    ) {
      throw new Error('Unconfirmed Bitcoin transaction status contains block data')
    }
    return Object.freeze({ confirmed: false })
  }
  if (typeof value.blockHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.blockHash)) {
    throw new Error('Invalid persisted Bitcoin block hash')
  }
  return Object.freeze({
    confirmed: true,
    blockHeight: parseSafeInteger(
      value.blockHeight,
      'Bitcoin transaction block height',
      2_147_483_647
    ),
    blockHash: value.blockHash,
    ...(value.blockTime === undefined
      ? {}
      : { blockTime: parseSafeInteger(value.blockTime, 'Bitcoin transaction block time') })
  })
}

function parseUtxo(value: unknown): BitcoinUtxo {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['transactionId', 'outputIndex', 'valueRaw', 'status']) ||
    typeof value.transactionId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.transactionId) ||
    typeof value.valueRaw !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.valueRaw) ||
    BigInt(value.valueRaw) > MAXIMUM_BITCOIN_SUPPLY_SATS
  ) {
    throw new Error('Invalid persisted Bitcoin UTXO')
  }
  return Object.freeze({
    transactionId: value.transactionId,
    outputIndex: parseSafeInteger(value.outputIndex, 'Bitcoin UTXO output index', 0xffffffff),
    valueRaw: value.valueRaw,
    status: parseTransactionStatus(value.status)
  })
}

function parseDerivedAddress(value: unknown, scope: BitcoinDiscoveryScope): DerivedBitcoinAddress {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'chainId',
        'addressType',
        'accountIndex',
        'change',
        'addressIndex',
        'address',
        'addressScheme',
        'derivationScheme',
        'derivationPath',
        'publicKey'
      ],
      ['masterFingerprint', 'scriptPubKey', 'redeemScript']
    ) ||
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.accountIndex !== scope.accountIndex ||
    (value.addressType !== 'p2pkh' &&
      value.addressType !== 'p2sh-p2wpkh' &&
      value.addressType !== 'p2wpkh' &&
      value.addressType !== 'p2tr') ||
    typeof value.change !== 'boolean' ||
    typeof value.address !== 'string' ||
    typeof value.publicKey !== 'string' ||
    !/^0x0[23][0-9a-f]{64}$/.test(value.publicKey)
  ) {
    throw new Error('Invalid persisted Bitcoin derived address')
  }
  const addressIndex = parseSafeInteger(
    value.addressIndex,
    'Bitcoin derived address index',
    BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET - 1
  )
  const profile =
    value.addressType === 'p2pkh'
      ? Object.freeze({ purpose: 44, addressScheme: 'bitcoin-p2pkh', derivationScheme: 'bip44' })
      : value.addressType === 'p2sh-p2wpkh'
        ? Object.freeze({
            purpose: 49,
            addressScheme: 'bitcoin-p2sh-p2wpkh',
            derivationScheme: 'bip49'
          })
        : value.addressType === 'p2wpkh'
          ? Object.freeze({
              purpose: 84,
              addressScheme: 'bitcoin-p2wpkh',
              derivationScheme: 'bip84'
            })
          : Object.freeze({
              purpose: 86,
              addressScheme: 'bitcoin-p2tr',
              derivationScheme: 'bip86'
            })
  const coinType =
    scope.chainAccount.scope.chainId === 'bip122:000000000019d6689c085ae165831e93' ? 0 : 1
  const imported = scope.chainAccount.derivation.scheme === 'imported'
  const expectedPath = imported
    ? 'm'
    : value.addressType === 'p2wpkh'
      ? `${scope.chainAccount.derivation.path.replace(/\/0\/0$/, '')}/${value.change ? 1 : 0}/${addressIndex}`
      : `m/${profile.purpose}'/${coinType}'/${scope.accountIndex}'/${value.change ? 1 : 0}/${addressIndex}`
  if (
    value.addressScheme !== profile.addressScheme ||
    value.derivationScheme !== (imported ? 'imported' : profile.derivationScheme) ||
    value.derivationPath !== expectedPath ||
    (imported && (value.change || addressIndex !== 0 || scope.accountIndex !== 0))
  ) {
    throw new Error('Persisted Bitcoin derived address metadata does not match its path')
  }
  const masterFingerprint = parseOptionalMasterFingerprint(value.masterFingerprint)
  const scriptPubKey = parseOptionalScript(value.scriptPubKey, 'scriptPubKey')
  const redeemScript = parseOptionalScript(value.redeemScript, 'redeemScript')
  const validScript =
    scriptPubKey === undefined
      ? value.addressType === 'p2wpkh' || value.addressType === 'p2tr'
      : value.addressType === 'p2pkh'
        ? /^0x76a914[0-9a-f]{40}88ac$/.test(scriptPubKey) && redeemScript === undefined
        : value.addressType === 'p2sh-p2wpkh'
          ? /^0xa914[0-9a-f]{40}87$/.test(scriptPubKey) &&
            typeof redeemScript === 'string' &&
            /^0x0014[0-9a-f]{40}$/.test(redeemScript)
          : value.addressType === 'p2wpkh'
            ? /^0x0014[0-9a-f]{40}$/.test(scriptPubKey) && redeemScript === undefined
            : /^0x5120[0-9a-f]{64}$/.test(scriptPubKey) && redeemScript === undefined
  if (!validScript) throw new Error('Invalid persisted Bitcoin derived address scripts')
  return Object.freeze({
    chainId: scope.chainAccount.scope.chainId,
    addressType: value.addressType,
    accountIndex: scope.accountIndex,
    change: value.change,
    addressIndex,
    address: parseSupportedBitcoinAddress(
      value.address,
      scope.chainAccount.scope.chainId,
      value.addressType
    ),
    addressScheme: profile.addressScheme,
    derivationScheme: imported ? 'imported' : profile.derivationScheme,
    derivationPath: expectedPath,
    publicKey: value.publicKey,
    ...(masterFingerprint === undefined ? {} : { masterFingerprint }),
    ...(scriptPubKey === undefined ? {} : { scriptPubKey }),
    ...(redeemScript === undefined ? {} : { redeemScript })
  })
}

export function parseObservation(
  value: unknown,
  scope: BitcoinDiscoveryScope
): BitcoinAddressObservation {
  if (!isRecord(value) || !hasExactKeys(value, ['derived', 'activity', 'utxos'])) {
    throw new Error('Invalid persisted Bitcoin address observation')
  }
  const derived = parseDerivedAddress(value.derived, scope)
  if (
    !isRecord(value.activity) ||
    !hasExactKeys(value.activity, [
      'confirmedTransactionCount',
      'mempoolTransactionCount',
      'used'
    ]) ||
    typeof value.activity.used !== 'boolean'
  ) {
    throw new Error('Invalid persisted Bitcoin address activity')
  }
  const confirmedTransactionCount = parseSafeInteger(
    value.activity.confirmedTransactionCount,
    'Bitcoin confirmed transaction count'
  )
  const mempoolTransactionCount = parseSafeInteger(
    value.activity.mempoolTransactionCount,
    'Bitcoin mempool transaction count'
  )
  if (value.activity.used !== confirmedTransactionCount + mempoolTransactionCount > 0) {
    throw new Error('Persisted Bitcoin address activity is inconsistent')
  }
  if (!Array.isArray(value.utxos) || value.utxos.length > MAXIMUM_UTXOS_PER_ADDRESS) {
    throw new Error('Invalid persisted Bitcoin UTXO inventory')
  }
  const seenUtxos = new Set<string>()
  const utxos = value.utxos.map(utxoValue => {
    const utxo = parseUtxo(utxoValue)
    const key = `${utxo.transactionId}:${utxo.outputIndex}`
    if (seenUtxos.has(key)) throw new Error('Duplicate persisted Bitcoin UTXO')
    seenUtxos.add(key)
    return utxo
  })
  if (!value.activity.used && utxos.length > 0) {
    throw new Error('Unused Bitcoin address cannot contain UTXOs')
  }
  return Object.freeze({
    derived,
    activity: Object.freeze({
      confirmedTransactionCount,
      mempoolTransactionCount,
      used: value.activity.used
    }),
    utxos: Object.freeze(utxos)
  })
}

export function observationKey(
  chainAccountId: string,
  observation: BitcoinAddressObservation
): string {
  return JSON.stringify([
    chainAccountId,
    observation.derived.addressType,
    observation.derived.change,
    observation.derived.addressIndex
  ])
}

export function addressKey(chainAccountId: string, observation: BitcoinAddressObservation): string {
  return JSON.stringify([chainAccountId, observation.derived.address])
}
