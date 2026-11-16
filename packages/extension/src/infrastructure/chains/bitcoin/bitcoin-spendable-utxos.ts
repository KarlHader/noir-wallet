import type { BitcoinAddressObservation, BitcoinSupportedAddressType } from '@/core/chains/bitcoin'
import {
  BITCOIN_MAXIMUM_MONEY_SATS,
  BITCOIN_MAXIMUM_SELECTION_UTXOS,
  BitcoinTransactionBuildError,
  bitcoinAccountRootFromPath,
  expectedBitcoinDerivationPath,
  failInvalidBitcoinTransaction,
  parseBitcoinAddress,
  parseBitcoinAddressType,
  parseBitcoinAmount,
  parseBitcoinChain,
  parseBitcoinIndex,
  parseBitcoinPublicKey,
  type BitcoinSpendableUtxo
} from './bitcoin-transaction-model'

const MAXIMUM_OUTPUT_INDEX = 0xffffffff

export function parseBitcoinSpendableUtxo(value: BitcoinSpendableUtxo): BitcoinSpendableUtxo {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).length !== 12 ||
    ![
      'chainId',
      'addressType',
      'accountIndex',
      'change',
      'addressIndex',
      'address',
      'derivationPath',
      'publicKey',
      'transactionId',
      'outputIndex',
      'valueSats',
      'blockHeight'
    ].every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin UTXO')
  }
  const chainId = parseBitcoinChain(value.chainId)
  const addressType = parseBitcoinAddressType(value.addressType)
  const accountIndex = parseBitcoinIndex(value.accountIndex, 'Bitcoin account index')
  const addressIndex = parseBitcoinIndex(value.addressIndex, 'Bitcoin address index')
  if (typeof value.change !== 'boolean')
    failInvalidBitcoinTransaction('Invalid Bitcoin change branch')
  const address = parseBitcoinAddress(value.address, chainId, addressType)
  const derivationPath = value.derivationPath
  bitcoinAccountRootFromPath(derivationPath, chainId, addressType, value.change, addressIndex)
  if (
    addressType !== 'p2wpkh' &&
    derivationPath !==
      expectedBitcoinDerivationPath(chainId, addressType, accountIndex, value.change, addressIndex)
  ) {
    failInvalidBitcoinTransaction('Invalid Bitcoin derivation path')
  }
  if (typeof value.transactionId !== 'string' || !/^[0-9a-f]{64}$/.test(value.transactionId)) {
    failInvalidBitcoinTransaction('Invalid Bitcoin transaction ID')
  }
  const outputIndex = parseBitcoinIndex(
    value.outputIndex,
    'Bitcoin output index',
    MAXIMUM_OUTPUT_INDEX
  )
  const blockHeight = parseBitcoinIndex(
    value.blockHeight,
    'Bitcoin confirmation height',
    0x7fffffff
  )
  return Object.freeze({
    chainId,
    addressType,
    accountIndex,
    change: value.change,
    addressIndex,
    address,
    derivationPath,
    publicKey: parseBitcoinPublicKey(value.publicKey),
    transactionId: value.transactionId,
    outputIndex,
    valueSats: parseBitcoinAmount(value.valueSats, 'Bitcoin UTXO value').toString(),
    blockHeight
  })
}

export function compareBitcoinUtxos(
  left: BitcoinSpendableUtxo,
  right: BitcoinSpendableUtxo
): number {
  if (left.valueSats !== right.valueSats) {
    return BigInt(right.valueSats) > BigInt(left.valueSats) ? 1 : -1
  }
  const transactionOrder = left.transactionId.localeCompare(right.transactionId)
  return transactionOrder === 0 ? left.outputIndex - right.outputIndex : transactionOrder
}

export function sumBitcoinUtxos(utxos: readonly BitcoinSpendableUtxo[]): bigint {
  let total = 0n
  for (const utxo of utxos) {
    total += BigInt(utxo.valueSats)
    if (total > BITCOIN_MAXIMUM_MONEY_SATS) {
      failInvalidBitcoinTransaction('Invalid Bitcoin UTXO total')
    }
  }
  return total
}

export function isActiveBitcoinAddressObservation(
  observation: BitcoinAddressObservation,
  addressType: BitcoinSupportedAddressType
): boolean {
  return (
    observation.derived.addressType === addressType &&
    observation.derived.change === false &&
    observation.derived.addressIndex === 0
  )
}

export function isLedgerBitcoinAccountObservation(
  observation: BitcoinAddressObservation,
  accountRoot: string
): boolean {
  if (observation.derived.addressType !== 'p2wpkh') return false
  const derived = observation.derived
  if (
    bitcoinAccountRootFromPath(
      derived.derivationPath,
      derived.chainId,
      derived.addressType,
      derived.change,
      derived.addressIndex
    ) !== accountRoot
  ) {
    failInvalidBitcoinTransaction('Ledger Bitcoin address belongs to another account')
  }
  return true
}

export function collectBitcoinSpendableUtxos(
  observations: readonly BitcoinAddressObservation[],
  addressType: BitcoinSupportedAddressType,
  ledgerAccountRoot?: string
): readonly BitcoinSpendableUtxo[] {
  parseBitcoinAddressType(addressType)
  if (!Array.isArray(observations)) {
    failInvalidBitcoinTransaction('Invalid Bitcoin discovery observations')
  }
  const seen = new Set<string>()
  const candidates: BitcoinSpendableUtxo[] = []
  for (const observation of observations) {
    if (
      ledgerAccountRoot === undefined
        ? !isActiveBitcoinAddressObservation(observation, addressType)
        : observation.derived.addressType !== addressType ||
          !isLedgerBitcoinAccountObservation(observation, ledgerAccountRoot)
    )
      continue
    if (!Array.isArray(observation.utxos)) {
      failInvalidBitcoinTransaction('Invalid Bitcoin discovery observation')
    }
    for (const utxo of observation.utxos) {
      if (!utxo?.status?.confirmed) continue
      const key = `${utxo.transactionId}:${utxo.outputIndex}`
      if (seen.has(key)) failInvalidBitcoinTransaction('Duplicate Bitcoin UTXO')
      seen.add(key)
      candidates.push(
        parseBitcoinSpendableUtxo({
          chainId: observation.derived.chainId,
          addressType: observation.derived.addressType,
          accountIndex: observation.derived.accountIndex,
          change: observation.derived.change,
          addressIndex: observation.derived.addressIndex,
          address: observation.derived.address,
          derivationPath: observation.derived.derivationPath,
          publicKey: observation.derived.publicKey,
          transactionId: utxo.transactionId,
          outputIndex: utxo.outputIndex,
          valueSats: utxo.valueRaw,
          blockHeight: utxo.status.blockHeight ?? 0
        })
      )
    }
  }
  if (candidates.length > BITCOIN_MAXIMUM_SELECTION_UTXOS) {
    throw new BitcoinTransactionBuildError(
      'capacity-exceeded',
      'Bitcoin UTXO selection capacity exceeded'
    )
  }
  return Object.freeze(candidates.sort(compareBitcoinUtxos))
}
