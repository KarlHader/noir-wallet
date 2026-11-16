import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib, type Psbt } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import {
  BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE,
  BitcoinTransactionBuildError,
  failInvalidSignedBitcoinTransaction,
  type FinalizeBitcoinPsbtInput,
  type FinalizedBitcoinTransaction
} from './bitcoin-transaction-model'
import { parseBitcoinPsbt, parsePreparedBitcoinPsbt } from './bitcoin-prepared-psbt-validator'

let eccInitialized = false

function ensureBitcoinEcc(): void {
  if (eccInitialized) return
  initEccLib(secp256k1)
  eccInitialized = true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key))
}

function hasSameKeys(left: object, right: object): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  )
}

function hasOwnExactKeys(value: object, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key))
}

function failSigned(): never {
  return failInvalidSignedBitcoinTransaction('Invalid signed Bitcoin transaction')
}

function optionalBufferEquals(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.equals(right)
}

function derivationEquals(
  left:
    | Readonly<{
        masterFingerprint: Buffer
        pubkey: Buffer
        path: string
        leafHashes?: Buffer[]
      }>
    | undefined,
  right:
    | Readonly<{
        masterFingerprint: Buffer
        pubkey: Buffer
        path: string
        leafHashes?: Buffer[]
      }>
    | undefined
): boolean {
  if (!left || !right) return false
  if (
    left.path !== right.path ||
    !left.masterFingerprint.equals(right.masterFingerprint) ||
    !left.pubkey.equals(right.pubkey)
  ) {
    return false
  }
  if (left.leafHashes === undefined || right.leafHashes === undefined) {
    return left.leafHashes === right.leafHashes
  }
  const leftLeafHashes = left.leafHashes
  const rightLeafHashes = right.leafHashes
  return (
    leftLeafHashes.length === rightLeafHashes.length &&
    leftLeafHashes.every((hash, index) => hash.equals(rightLeafHashes[index]))
  )
}

function assertSigningMetadataMatches(unsignedPsbt: Psbt, signedPsbt: Psbt): void {
  if (
    !hasOwnExactKeys(signedPsbt.data.globalMap, ['unsignedTx']) ||
    !hasSameKeys(unsignedPsbt.data.globalMap, signedPsbt.data.globalMap)
  ) {
    return failSigned()
  }
  if (unsignedPsbt.data.inputs.length !== signedPsbt.data.inputs.length) return failSigned()
  for (let index = 0; index < unsignedPsbt.data.inputs.length; index += 1) {
    const expected = unsignedPsbt.data.inputs[index]
    const actual = signedPsbt.data.inputs[index]
    const signatureKey = expected.tapInternalKey === undefined ? 'partialSig' : 'tapKeySig'
    const expectedSignedKeys = [...Object.keys(expected), signatureKey].sort()
    if (
      !actual ||
      Object.keys(actual).sort().join('\0') !== expectedSignedKeys.join('\0') ||
      (expected.witnessUtxo === undefined) !== (actual.witnessUtxo === undefined) ||
      (expected.witnessUtxo !== undefined &&
        actual.witnessUtxo !== undefined &&
        (expected.witnessUtxo.value !== actual.witnessUtxo.value ||
          !expected.witnessUtxo.script.equals(actual.witnessUtxo.script))) ||
      !optionalBufferEquals(expected.nonWitnessUtxo, actual.nonWitnessUtxo) ||
      !optionalBufferEquals(expected.redeemScript, actual.redeemScript) ||
      expected.bip32Derivation?.length !== actual.bip32Derivation?.length ||
      expected.tapBip32Derivation?.length !== actual.tapBip32Derivation?.length ||
      !optionalBufferEquals(expected.tapInternalKey, actual.tapInternalKey) ||
      (expected.bip32Derivation?.length === 1 &&
        !derivationEquals(expected.bip32Derivation[0], actual.bip32Derivation?.[0])) ||
      (expected.tapBip32Derivation?.length === 1 &&
        !derivationEquals(expected.tapBip32Derivation[0], actual.tapBip32Derivation?.[0])) ||
      actual.finalScriptSig !== undefined ||
      actual.finalScriptWitness !== undefined
    ) {
      return failSigned()
    }
    if (
      (signatureKey === 'partialSig' && actual.partialSig?.length !== 1) ||
      (signatureKey === 'tapKeySig' &&
        (actual.tapKeySig === undefined ||
          (actual.tapKeySig.length !== 64 && actual.tapKeySig.length !== 65)))
    ) {
      return failSigned()
    }
  }
  if (unsignedPsbt.data.outputs.length !== signedPsbt.data.outputs.length) return failSigned()
  for (let index = 0; index < unsignedPsbt.data.outputs.length; index += 1) {
    const expected = unsignedPsbt.data.outputs[index]
    const actual = signedPsbt.data.outputs[index]
    if (
      !actual ||
      !hasSameKeys(expected, actual) ||
      expected.bip32Derivation?.length !== actual.bip32Derivation?.length ||
      expected.tapBip32Derivation?.length !== actual.tapBip32Derivation?.length ||
      !optionalBufferEquals(expected.tapInternalKey, actual.tapInternalKey) ||
      (expected.bip32Derivation?.length === 1 &&
        !derivationEquals(expected.bip32Derivation[0], actual.bip32Derivation?.[0])) ||
      (expected.tapBip32Derivation?.length === 1 &&
        !derivationEquals(expected.tapBip32Derivation[0], actual.tapBip32Derivation?.[0]))
    ) {
      return failSigned()
    }
  }
}

function finalize(input: FinalizeBitcoinPsbtInput): FinalizedBitcoinTransaction {
  ensureBitcoinEcc()
  if (!hasExactKeys(input, ['prepared', 'signedPsbtBase64'])) return failSigned()
  const { prepared, psbt: unsignedPsbt } = parsePreparedBitcoinPsbt(input.prepared)
  const signedPsbt = parseBitcoinPsbt(input.signedPsbtBase64, prepared.chainId)
  if (
    !signedPsbt.data.globalMap.unsignedTx
      .toBuffer()
      .equals(unsignedPsbt.data.globalMap.unsignedTx.toBuffer())
  ) {
    return failSigned()
  }
  assertSigningMetadataMatches(unsignedPsbt, signedPsbt)
  const signaturesValid = signedPsbt.validateSignaturesOfAllInputs((publicKey, hash, signature) =>
    publicKey.length === 32
      ? secp256k1.verifySchnorr(hash, publicKey, signature)
      : secp256k1.verify(hash, publicKey, signature)
  )
  if (!signaturesValid) return failSigned()

  signedPsbt.setMaximumFeeRate(BITCOIN_MAXIMUM_FEE_RATE_SATS_PER_VBYTE)
  signedPsbt.finalizeAllInputs()
  const transaction = signedPsbt.extractTransaction()
  const vbytes = transaction.virtualSize()
  const feeSats = BigInt(prepared.feeSats)
  if (
    ((prepared.addressType === 'p2wpkh' || prepared.addressType === 'p2tr') &&
      transaction.getId() !== prepared.unsignedTransactionId) ||
    vbytes > prepared.estimatedVbytes ||
    feeSats < BigInt(vbytes) * BigInt(prepared.feeRateSatsPerVbyte)
  ) {
    return failSigned()
  }
  return Object.freeze({
    transactionId: transaction.getId(),
    rawTransactionHex: transaction.toHex(),
    finalizedPsbtBase64: signedPsbt.toBase64(),
    vbytes,
    feeSats: feeSats.toString(),
    feeRateSatsPerVbyte: Number(feeSats) / vbytes
  })
}

export function finalizeBitcoinPsbt(input: FinalizeBitcoinPsbtInput): FinalizedBitcoinTransaction {
  try {
    return finalize(input)
  } catch (error) {
    if (
      error instanceof BitcoinTransactionBuildError &&
      error.code === 'invalid-signed-transaction'
    ) {
      throw error
    }
    return failSigned()
  }
}
