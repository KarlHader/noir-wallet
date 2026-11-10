import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { initEccLib } from 'bitcoinjs-lib'
import { DASH_MAX_RELAY_FEE_DUFFS_PER_KB, DASH_LEGACY_FEE_BYTES_PER_KB } from './config'
import {
  DashTransactionBuildError,
  failInvalidSignedDashTransaction,
  isPlainRecord,
  type FinalizeDashPsbtInput,
  type FinalizedDashTransaction
} from './dash-transaction-model'
import { assertDashSignedPsbtMatchesPrepared } from './dash-prepared-psbt-validator'

let eccReady = false

function ensureEcc(): void {
  if (eccReady) return
  initEccLib(secp256k1)
  eccReady = true
}

function fail(): never {
  return failInvalidSignedDashTransaction('Signed Dash transaction does not match the review')
}

function finalize(input: FinalizeDashPsbtInput): FinalizedDashTransaction {
  ensureEcc()
  if (!isPlainRecord(input) || Object.keys(input).length !== 2) return fail()
  const signed = assertDashSignedPsbtMatchesPrepared(input.prepared, input.signedPsbtBase64)
  const valid = signed.validateSignaturesOfAllInputs((publicKey, hash, signature) =>
    secp256k1.verify(hash, publicKey, signature)
  )
  if (!valid) return fail()
  signed.setMaximumFeeRate(
    Number(DASH_MAX_RELAY_FEE_DUFFS_PER_KB / DASH_LEGACY_FEE_BYTES_PER_KB) + 1
  )
  signed.finalizeAllInputs()
  const transaction = signed.extractTransaction()
  const legacyBytes = transaction.byteLength()
  if ((transaction.version & 0xffff) !== 2 || transaction.version >>> 16 !== 0) return fail()
  const fee = BigInt(input.prepared.feeDuffs)
  const minimum = (BigInt(legacyBytes) * BigInt(input.prepared.feeRateDuffsPerKb) + 999n) / 1000n
  if (legacyBytes > input.prepared.legacyBytes || fee < minimum) return fail()
  return Object.freeze({
    transactionId: transaction.getId(),
    rawTransactionHex: transaction.toHex(),
    finalizedPsbtBase64: signed.toBase64(),
    legacyBytes,
    feeDuffs: fee.toString()
  })
}

export function finalizeDashPsbt(input: FinalizeDashPsbtInput): FinalizedDashTransaction {
  try {
    return finalize(input)
  } catch (error) {
    if (error instanceof DashTransactionBuildError && error.code === 'invalid-signed-transaction') {
      throw error
    }
    return fail()
  }
}
