import { blake2b } from '@noble/hashes/blake2b'
import { parseQuantusAddress, decodeQuantusAccountId } from '@/core/chains/quantus'
import type { ChainId } from '@/core/chains/domain'
import type { QuantusTransferSummary } from '@/core/keyring/domain/signing-summary'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import { bytesToHex, hexToBytes } from '@/lib/bytes'

/**
 * Bounded verifier for a signed Quantus native transfer.
 *
 * The host must be able to prove, from the exact returned bytes, that the
 * signature covers the reviewed transfer. The packaged engine's fee gate cannot
 * do that: it forwards bytes to the RPC. This module decodes only the signed
 * extrinsic shape it needs (`Signed` v4 native balance transfer) and rejects
 * everything else instead of guessing:
 *
 * - compact length prefix + version `0x84`,
 * - `MultiAddress::Id` signer account id equal to the reviewed signer,
 * - `Dilithium*SignatureWithPublic` is encoded as signature bytes followed by
 *   public-key bytes (the runtime derives the signer account from that key),
 * - mortal era whose length matches the reviewed era period,
 * - nonce and tip equal to the reviewed values, one disabled metadata-hash byte,
 * - the trailing call equals the reviewed `callHash`/`callLength`, and decodes to
 *   `pallet_balances::{transfer, transfer_keep_alive}` for the reviewed
 *   recipient, amount and keep-alive flag.
 *
 * The era *start* is chosen by the engine and is not reconstructed here; the
 * caller bounds the validity window with the reviewed period instead. Immortal
 * eras are rejected because the reviewed request forbids them.
 */

const MAXIMUM_EXTRINSIC_BYTES = 16 * 1024
const SIGNED_V4_VERSION = 0x84
const MULTI_ADDRESS_ID = 0x00
const BALANCES_PALLET_INDEX = 0x02
const BALANCES_TRANSFER = 0x00
const BALANCES_TRANSFER_KEEP_ALIVE = 0x03
const MAXIMUM_U128 = (1n << 128n) - 1n

/** FIPS 204 encoded sizes: (public key, signature). */
const ML_DSA_SIGNATURE_SHAPES = Object.freeze({
  'ml-dsa-87': Object.freeze({ variant: 0x00, publicKeyBytes: 2592, signatureBytes: 4627 }),
  'ml-dsa-65': Object.freeze({ variant: 0x01, publicKeyBytes: 1952, signatureBytes: 3309 })
})

export interface VerifyQuantusSignedTransferInput {
  /** The approved `signing.prepare` summary, not values rebuilt from the request. */
  readonly summary: unknown
  /** The exact bytes returned by `signing.confirm`. */
  readonly signedExtrinsicHex: unknown
  readonly chainId: ChainId
}

export interface VerifiedQuantusSignedTransfer {
  readonly signedExtrinsicHex: string
  /** Blake2b-256 of the exact extrinsic bytes, matching the engine's hash. */
  readonly extrinsicHash: string
  readonly scheme: QuantusTransferSummary['fields']['scheme']
  readonly nonce: number
  readonly eraPeriod: number
}

class QuantusExtrinsicReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  peek(): number {
    if (this.remaining < 1) throw new Error('Quantus extrinsic is truncated')
    return this.bytes[this.offset]
  }

  byte(label: string): number {
    if (this.remaining < 1) throw new Error(`Quantus extrinsic is missing ${label}`)
    return this.bytes[this.offset++]
  }

  take(length: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining < length) {
      throw new Error(`Quantus extrinsic is missing ${label}`)
    }
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  /** SCALE compact unsigned integer. */
  compact(label: string, maximum: bigint): bigint {
    const first = this.byte(label)
    const mode = first & 0b11
    let value: bigint
    let length = 1
    switch (mode) {
      case 0:
        value = BigInt(first >>> 2)
        break
      case 1: {
        const second = this.byte(label)
        const raw = (first | (second << 8)) >>> 2
        if (raw < 1 << 6) throw new Error(`Quantus ${label} is not canonical`)
        value = BigInt(raw)
        break
      }
      case 2: {
        const rest = this.take(3, label)
        const raw = (first | (rest[0] << 8) | (rest[1] << 16) | (rest[2] << 24)) >>> 2
        if (raw < 1 << 14) throw new Error(`Quantus ${label} is not canonical`)
        value = BigInt(raw)
        length = 4
        break
      }
      default: {
        const byteLength = (first >>> 2) + 4
        const data = this.take(byteLength, label)
        if (data[byteLength - 1] === 0) throw new Error(`Quantus ${label} is not canonical`)
        let text = '0x'
        for (let index = data.byteLength - 1; index >= 0; index -= 1) {
          text += data[index].toString(16).padStart(2, '0')
        }
        value = BigInt(text)
        length = 1 + byteLength
        break
      }
    }
    if (value > maximum) throw new Error(`Quantus ${label} exceeds its range`)
    // `length` is only used to keep the canonical checks readable.
    void length
    return value
  }
}

function readEraPeriod(era: Uint8Array): number {
  // Substrate encodes a mortal era length in the low nibble as
  // `trailingZeros(period) - 1`.
  const exponent = (era[0] & 0x0f) + 1
  if (exponent < 2 || exponent > 16) throw new Error('Quantus extrinsic era is invalid')
  return 2 ** exponent
}

function verifyCall(call: Uint8Array, summary: QuantusTransferSummary): void {
  const reader = new QuantusExtrinsicReader(call)
  if (reader.byte('balances pallet index') !== BALANCES_PALLET_INDEX) {
    throw new Error('Quantus extrinsic call is not a balances transfer')
  }
  const callIndex = reader.byte('balances call index')
  const keepAlive =
    callIndex === BALANCES_TRANSFER_KEEP_ALIVE
      ? true
      : callIndex === BALANCES_TRANSFER
        ? false
        : null
  if (keepAlive === null) throw new Error('Quantus extrinsic call is not a balances transfer')
  if (keepAlive !== summary.fields.keepAlive) {
    throw new Error('Quantus extrinsic keep-alive flag does not match the review')
  }
  if (reader.byte('transfer destination variant') !== MULTI_ADDRESS_ID) {
    throw new Error('Quantus extrinsic destination is not a 32-byte account id')
  }
  const recipient = reader.take(32, 'transfer destination')
  const reviewedRecipient = decodeQuantusAccountId(summary.fields.recipient, 'Quantus recipient')
  if (bytesToHex(recipient) !== bytesToHex(reviewedRecipient)) {
    throw new Error('Quantus extrinsic recipient does not match the review')
  }
  const amount = reader.compact('transfer amount', MAXIMUM_U128)
  if (amount !== BigInt(summary.fields.amountRaw)) {
    throw new Error('Quantus extrinsic amount does not match the review')
  }
  if (reader.remaining !== 0) {
    throw new Error('Quantus extrinsic call has trailing bytes')
  }
}

export function verifyQuantusSignedTransfer(
  input: VerifyQuantusSignedTransferInput
): VerifiedQuantusSignedTransfer {
  if (
    typeof input.signedExtrinsicHex !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.signedExtrinsicHex) ||
    input.signedExtrinsicHex.length > MAXIMUM_EXTRINSIC_BYTES * 2 + 2
  ) {
    throw new Error('Invalid signed Quantus extrinsic')
  }
  const signedExtrinsicHex = input.signedExtrinsicHex.toLowerCase()
  const bytes = hexToBytes(signedExtrinsicHex)
  const summary = parseSigningSummary(input.summary, {
    family: 'quantus',
    chainId: input.chainId,
    operation: 'transaction'
  }) as QuantusTransferSummary
  if (summary.review.level === 'blocked') {
    throw new Error('Quantus review is blocked')
  }
  parseQuantusAddress(summary.fields.signerAddress, 'Quantus signer')
  if (
    bytesToHex(decodeQuantusAccountId(summary.fields.signerAddress, 'Quantus signer')) !==
    summary.fields.signerAccountId.slice(2)
  ) {
    throw new Error('Quantus review signer address and account id disagree')
  }

  const reader = new QuantusExtrinsicReader(bytes)
  const bodyLength = Number(reader.compact('extrinsic length', BigInt(bytes.byteLength)))
  if (bodyLength !== reader.remaining) {
    throw new Error('Quantus extrinsic length prefix does not match its body')
  }
  if (reader.byte('extrinsic version') !== SIGNED_V4_VERSION) {
    throw new Error('Quantus extrinsic must be a signed v4 extrinsic')
  }
  if (reader.byte('account variant') !== MULTI_ADDRESS_ID) {
    throw new Error('Quantus extrinsic signer is not a 32-byte account id')
  }
  const signerAccountId = reader.take(32, 'signer account id')
  if (bytesToHex(signerAccountId) !== summary.fields.signerAccountId.slice(2)) {
    throw new Error('Quantus extrinsic signer does not match the review')
  }

  const shape = ML_DSA_SIGNATURE_SHAPES[summary.fields.scheme]
  if (reader.byte('signature variant') !== shape.variant) {
    throw new Error('Quantus extrinsic signature scheme does not match the review')
  }
  reader.take(shape.signatureBytes, 'ML-DSA signature')
  reader.take(shape.publicKeyBytes, 'ML-DSA public key')

  const era = reader.take(2, 'extrinsic era')
  if (era[0] === 0x00) throw new Error('Quantus extrinsic era must be mortal')
  const eraPeriod = readEraPeriod(era)
  if (eraPeriod !== summary.fields.eraPeriod) {
    throw new Error('Quantus extrinsic era period does not match the review')
  }
  const nonce = reader.compact('extrinsic nonce', BigInt(0xffffffff))
  if (nonce !== BigInt(summary.fields.nonce)) {
    throw new Error('Quantus extrinsic nonce does not match the review')
  }
  const tip = reader.compact('extrinsic tip', MAXIMUM_U128)
  if (tip !== BigInt(summary.fields.tipRaw)) {
    throw new Error('Quantus extrinsic tip does not match the review')
  }
  if (reader.byte('metadata hash mode') !== 0x00) {
    throw new Error('Quantus extrinsic metadata hash mode is unsupported')
  }

  const call = reader.take(reader.remaining, 'extrinsic call')
  if (call.byteLength !== summary.fields.callLength) {
    throw new Error('Quantus extrinsic call length does not match the review')
  }
  if (`0x${bytesToHex(blake2b(call, { dkLen: 32 }))}` !== summary.fields.callHash) {
    throw new Error('Quantus extrinsic call hash does not match the review')
  }
  verifyCall(call, summary)

  return Object.freeze({
    signedExtrinsicHex,
    extrinsicHash: `0x${bytesToHex(blake2b(bytes, { dkLen: 32 }))}`,
    scheme: summary.fields.scheme,
    nonce: Number(nonce),
    eraPeriod
  })
}
