import type { PearlAddressObservation } from '@/core/chains/pearl'
import {
  PEARL_MAXIMUM_MONEY_SATS,
  PEARL_MAXIMUM_SELECTION_UTXOS,
  PearlTransactionBuildError,
  expectedPearlDerivationPath,
  failInvalidPearlTransaction,
  parsePearlAddress,
  parsePearlAmount,
  parsePearlChain,
  parsePearlIndex,
  parsePearlPublicKey,
  type PearlSpendableUtxo
} from './pearl-transaction-model'

const MAXIMUM_OUTPUT_INDEX = 0xffffffff

export function parsePearlSpendableUtxo(value: PearlSpendableUtxo): PearlSpendableUtxo {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).length !== 12 ||
    ![
      'chainId',
      'addressScheme',
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
    failInvalidPearlTransaction('Invalid Pearl UTXO')
  }
  const chainId = parsePearlChain(value.chainId)
  if (value.addressScheme !== 'pearl_p2tr') {
    failInvalidPearlTransaction('Invalid Pearl address scheme')
  }
  const accountIndex = parsePearlIndex(value.accountIndex, 'Pearl account index')
  const addressIndex = parsePearlIndex(value.addressIndex, 'Pearl address index')
  if (typeof value.change !== 'boolean') {
    failInvalidPearlTransaction('Invalid Pearl change branch')
  }
  const address = parsePearlAddress(value.address, chainId)
  const imported = value.derivationPath === 'm'
  const expectedPath = imported
    ? 'm'
    : expectedPearlDerivationPath(chainId, accountIndex, value.change, addressIndex)
  if (value.derivationPath !== expectedPath) {
    failInvalidPearlTransaction('Invalid Pearl derivation path')
  }
  if (typeof value.transactionId !== 'string' || !/^[0-9a-f]{64}$/.test(value.transactionId)) {
    failInvalidPearlTransaction('Invalid Pearl transaction ID')
  }
  const outputIndex = parsePearlIndex(value.outputIndex, 'Pearl output index', MAXIMUM_OUTPUT_INDEX)
  const blockHeight = parsePearlIndex(value.blockHeight, 'Pearl confirmation height')
  const valueSats =
    value.valueSats === '0' ? '0' : parsePearlAmount(value.valueSats, 'Pearl UTXO value').toString()
  return Object.freeze({
    chainId,
    addressScheme: 'pearl_p2tr',
    accountIndex,
    change: value.change,
    addressIndex,
    address,
    derivationPath: expectedPath,
    publicKey: parsePearlPublicKey(value.publicKey),
    transactionId: value.transactionId,
    outputIndex,
    valueSats,
    blockHeight
  })
}

export function comparePearlUtxos(left: PearlSpendableUtxo, right: PearlSpendableUtxo): number {
  if (left.valueSats !== right.valueSats) {
    return BigInt(right.valueSats) > BigInt(left.valueSats) ? 1 : -1
  }
  const transactionOrder = left.transactionId.localeCompare(right.transactionId)
  return transactionOrder === 0 ? left.outputIndex - right.outputIndex : transactionOrder
}

export function sumPearlUtxos(utxos: readonly PearlSpendableUtxo[]): bigint {
  let total = 0n
  for (const utxo of utxos) {
    total += BigInt(utxo.valueSats)
    if (total > PEARL_MAXIMUM_MONEY_SATS) {
      failInvalidPearlTransaction('Invalid Pearl UTXO total')
    }
  }
  return total
}

export function isActivePearlAddressObservation(observation: PearlAddressObservation): boolean {
  return observation.derived.change === false && observation.derived.addressIndex === 0
}

export function collectPearlSpendableUtxos(
  observations: readonly PearlAddressObservation[]
): readonly PearlSpendableUtxo[] {
  if (!Array.isArray(observations)) {
    failInvalidPearlTransaction('Invalid Pearl discovery observations')
  }
  const seen = new Set<string>()
  const candidates: PearlSpendableUtxo[] = []
  for (const observation of observations) {
    if (!isActivePearlAddressObservation(observation)) continue
    if (!Array.isArray(observation.utxos)) {
      failInvalidPearlTransaction('Invalid Pearl discovery observation')
    }
    for (const utxo of observation.utxos) {
      if (!utxo?.status?.confirmed) continue
      const key = `${utxo.transactionId}:${utxo.outputIndex}`
      if (seen.has(key)) failInvalidPearlTransaction('Duplicate Pearl UTXO')
      seen.add(key)
      candidates.push(
        parsePearlSpendableUtxo({
          chainId: parsePearlChain(observation.derived.chainId),
          addressScheme: 'pearl_p2tr',
          accountIndex: observation.derived.accountIndex,
          change: observation.derived.change,
          addressIndex: observation.derived.addressIndex,
          address: observation.derived.address,
          derivationPath: observation.derived.derivationPath,
          publicKey: observation.derived.publicKey,
          transactionId: utxo.transactionId,
          outputIndex: utxo.outputIndex,
          valueSats: utxo.valueSats,
          blockHeight: utxo.status.blockHeight
        })
      )
    }
  }
  if (candidates.length > PEARL_MAXIMUM_SELECTION_UTXOS) {
    throw new PearlTransactionBuildError(
      'capacity-exceeded',
      'Pearl UTXO selection capacity exceeded'
    )
  }
  return Object.freeze(candidates.sort(comparePearlUtxos))
}
