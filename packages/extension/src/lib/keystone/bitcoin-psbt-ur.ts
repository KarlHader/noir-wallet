// Must come first: installs the global Buffer required by the UR libraries.
import '../buffer-polyfill'
import { Buffer } from 'buffer'
import { CryptoPSBT } from '@keystonehq/bc-ur-registry'
import { UR, UREncoder } from '@ngraveio/bc-ur'
import { Psbt } from 'bitcoinjs-lib'

export const KEYSTONE_BITCOIN_PSBT_UR_TYPE = 'crypto-psbt' as const
export const DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH = 200

const MIN_PSBT_BYTES = 8
const MAX_PSBT_BYTES = 1024 * 1024
const PSBT_MAGIC = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff])

function copyAndValidatePsbtBytes(value: Uint8Array, label: string): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < MIN_PSBT_BYTES ||
    value.byteLength > MAX_PSBT_BYTES ||
    !PSBT_MAGIC.every((byte, index) => value[index] === byte)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  const bytes = Uint8Array.from(value)
  try {
    Psbt.fromBuffer(Buffer.from(bytes))
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  return bytes
}

function parseCryptoPsbt(ur: UR, label: string): Uint8Array {
  if (ur.type !== KEYSTONE_BITCOIN_PSBT_UR_TYPE) {
    throw new Error(`Unexpected QR content: ${ur.type} (expected ${KEYSTONE_BITCOIN_PSBT_UR_TYPE})`)
  }
  if (ur.cbor.byteLength === 0 || ur.cbor.byteLength > MAX_PSBT_BYTES + 16) {
    throw new Error(`Invalid ${label}`)
  }
  try {
    return copyAndValidatePsbtBytes(
      new Uint8Array(CryptoPSBT.fromCBOR(Buffer.from(ur.cbor)).getPSBT()),
      label
    )
  } catch (error) {
    if (error instanceof Error && error.message === `Invalid ${label}`) throw error
    throw new Error(`Invalid ${label}`)
  }
}

export function createBitcoinPsbtUREncoder(
  unsignedPsbtBytes: Uint8Array,
  maxFragmentLength = DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH
): UREncoder {
  if (
    !Number.isSafeInteger(maxFragmentLength) ||
    maxFragmentLength < 10 ||
    maxFragmentLength > 4096
  ) {
    throw new Error('Invalid Bitcoin PSBT QR fragment length')
  }
  const psbt = copyAndValidatePsbtBytes(unsignedPsbtBytes, 'unsigned Bitcoin PSBT')
  const cryptoPsbt = new CryptoPSBT(Buffer.from(psbt))
  return new UREncoder(
    new UR(Buffer.from(cryptoPsbt.toCBOR()), KEYSTONE_BITCOIN_PSBT_UR_TYPE),
    maxFragmentLength
  )
}

export function parseSignedBitcoinPsbt(ur: UR): Uint8Array {
  return parseCryptoPsbt(ur, 'signed Bitcoin PSBT')
}

export function assertKeystoneSignedBitcoinPsbtMatchesRequest(
  unsignedPsbtBytes: Uint8Array,
  signedPsbtBytes: Uint8Array
): void {
  let unsigned: Psbt
  let signed: Psbt
  try {
    unsigned = Psbt.fromBuffer(
      Buffer.from(copyAndValidatePsbtBytes(unsignedPsbtBytes, 'unsigned Bitcoin PSBT'))
    )
    signed = Psbt.fromBuffer(
      Buffer.from(copyAndValidatePsbtBytes(signedPsbtBytes, 'signed Bitcoin PSBT'))
    )
  } catch {
    throw new Error('Keystone signed Bitcoin PSBT does not match the request')
  }

  if (
    !signed.data.globalMap.unsignedTx
      .toBuffer()
      .equals(unsigned.data.globalMap.unsignedTx.toBuffer()) ||
    signed.data.inputs.length !== unsigned.data.inputs.length ||
    signed.data.outputs.length !== unsigned.data.outputs.length
  ) {
    throw new Error('Keystone signed Bitcoin PSBT does not match the request')
  }
}
