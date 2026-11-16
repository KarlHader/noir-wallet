import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import type { LedgerPcztSignatures } from '@/core/worker/types'

const DER_SEQUENCE_TAG = 0x30
const LEDGER_RECOVERY_BIT = 0x01
const SIGHASH_ALL = 0x01

function parseSignature(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length > 128) throw new Error(`Invalid ${label}`)
  const bytes = base64ToBytes(value)
  if (bytes.length < min || bytes.length > max || bytesToBase64(bytes) !== value) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export function parseLedgerPcztSignatures(value: unknown): LedgerPcztSignatures {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Ledger signatures')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'ironwood,orchard,transparentInputSigs' ||
    !Array.isArray(record.orchard) ||
    !Array.isArray(record.transparentInputSigs) ||
    !Array.isArray(record.ironwood) ||
    [record.orchard, record.transparentInputSigs, record.ironwood].some(
      items => items.length > 1024
    )
  ) {
    throw new Error('Invalid Ledger signatures')
  }
  const parseShielded = (item: unknown) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      Object.keys(item).join(',') !== 'spendAuthSig'
    ) {
      throw new Error('Invalid Ledger shielded signature')
    }
    return {
      spendAuthSig: parseSignature(
        (item as Record<string, unknown>).spendAuthSig,
        'Ledger shielded signature',
        64,
        64
      )
    }
  }
  return {
    orchard: record.orchard.map(parseShielded),
    transparentInputSigs: record.transparentInputSigs.map(signature =>
      parseSignature(signature, 'Ledger transparent signature', 8, 80)
    ),
    ironwood: record.ironwood.map(parseShielded)
  }
}

/** Converts Ledger's recoverable ECDSA encoding to canonical DER + sighash. */
export function normalizeLedgerTransparentSignature(signature: Uint8Array): Uint8Array {
  if (signature.length < 9 || signature.length > 80) {
    throw new Error('Ledger returned an invalid transparent signature length')
  }
  if (signature[signature.length - 1] !== SIGHASH_ALL) {
    throw new Error('Ledger returned an unsupported transparent signature sighash type')
  }

  const header = signature[0]
  if ((header & ~LEDGER_RECOVERY_BIT) !== DER_SEQUENCE_TAG) {
    throw new Error('Ledger returned an invalid transparent signature encoding')
  }
  const rLength = signature[3]
  const sTagIndex = 4 + rLength
  const sLength = signature[sTagIndex + 1]
  if (
    signature[1] !== signature.length - 3 ||
    signature[2] !== 0x02 ||
    rLength === 0 ||
    sTagIndex + 2 >= signature.length - 1 ||
    signature[sTagIndex] !== 0x02 ||
    sLength === 0 ||
    sTagIndex + 2 + sLength !== signature.length - 1
  ) {
    throw new Error('Ledger returned an invalid transparent signature encoding')
  }

  const normalized = signature.slice()
  normalized[0] = DER_SEQUENCE_TAG
  return normalized
}
