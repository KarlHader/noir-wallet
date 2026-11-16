import { encodeSolanaBase58, parseCanonicalBase64 } from './solana-rpc-codecs'

const MAXIMUM_TRANSACTION_BYTES = 1_232
const SIGNATURE_BYTES = 64
const PUBLIC_KEY_BYTES = 32

export interface SolanaTransactionLookupReference {
  readonly accountKey: string
  readonly writableIndexes: readonly number[]
  readonly readonlyIndexes: readonly number[]
}

export interface ParsedSolanaTransactionEnvelope {
  readonly messageVersion: 'legacy' | 'v0'
  readonly messageBase64: string
  readonly addressTableLookups: readonly SolanaTransactionLookupReference[]
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function readShortVector(bytes: Uint8Array, cursor: { offset: number }, label: string): number {
  let value = 0
  let shift = 0
  for (let count = 0; count < 3; count += 1) {
    const byte = bytes[cursor.offset]
    if (byte === undefined) throw new Error(`Truncated Solana ${label}`)
    cursor.offset += 1
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
  throw new Error(`Invalid Solana ${label}`)
}

function readBytes(
  bytes: Uint8Array,
  cursor: { offset: number },
  length: number,
  label: string
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > bytes.byteLength) {
    throw new Error(`Truncated Solana ${label}`)
  }
  const value = bytes.subarray(cursor.offset, cursor.offset + length)
  cursor.offset += length
  return value
}

function readByte(bytes: Uint8Array, cursor: { offset: number }, label: string): number {
  return readBytes(bytes, cursor, 1, label)[0]
}

function skipCompiledInstructions(bytes: Uint8Array, cursor: { offset: number }): void {
  const instructionCount = readShortVector(bytes, cursor, 'instruction count')
  for (let index = 0; index < instructionCount; index += 1) {
    readByte(bytes, cursor, `instruction ${index} program index`)
    const accountCount = readShortVector(bytes, cursor, `instruction ${index} account count`)
    readBytes(bytes, cursor, accountCount, `instruction ${index} accounts`)
    const dataLength = readShortVector(bytes, cursor, `instruction ${index} data length`)
    readBytes(bytes, cursor, dataLength, `instruction ${index} data`)
  }
}

function parseMessage(message: Uint8Array): ParsedSolanaTransactionEnvelope {
  const cursor = { offset: 0 }
  const first = readByte(message, cursor, 'message header')
  const messageVersion = (first & 0x80) === 0 ? 'legacy' : 'v0'
  if (messageVersion === 'v0' && first !== 0x80) {
    throw new Error('Unsupported Solana message version')
  }
  readBytes(message, cursor, messageVersion === 'v0' ? 3 : 2, 'message header')
  const staticAccountCount = readShortVector(message, cursor, 'static account count')
  readBytes(message, cursor, staticAccountCount * PUBLIC_KEY_BYTES, 'static accounts')
  readBytes(message, cursor, PUBLIC_KEY_BYTES, 'recent blockhash')
  skipCompiledInstructions(message, cursor)

  const addressTableLookups: SolanaTransactionLookupReference[] = []
  if (messageVersion === 'v0') {
    const lookupCount = readShortVector(message, cursor, 'address lookup table count')
    for (let index = 0; index < lookupCount; index += 1) {
      const accountKey = encodeSolanaBase58(
        readBytes(message, cursor, PUBLIC_KEY_BYTES, `address lookup table ${index} key`)
      )
      const writableCount = readShortVector(
        message,
        cursor,
        `address lookup table ${index} writable count`
      )
      const writableIndexes = Object.freeze([
        ...readBytes(
          message,
          cursor,
          writableCount,
          `address lookup table ${index} writable indexes`
        )
      ])
      const readonlyCount = readShortVector(
        message,
        cursor,
        `address lookup table ${index} readonly count`
      )
      const readonlyIndexes = Object.freeze([
        ...readBytes(
          message,
          cursor,
          readonlyCount,
          `address lookup table ${index} readonly indexes`
        )
      ])
      addressTableLookups.push(Object.freeze({ accountKey, writableIndexes, readonlyIndexes }))
    }
  }
  if (cursor.offset !== message.byteLength)
    throw new Error('Unexpected trailing Solana message data')
  return Object.freeze({
    messageVersion,
    messageBase64: encodeBase64(message),
    addressTableLookups: Object.freeze(addressTableLookups)
  })
}

export function parseSolanaTransactionEnvelope(
  transactionBase64: string
): ParsedSolanaTransactionEnvelope {
  const transaction = parseCanonicalBase64(
    transactionBase64,
    MAXIMUM_TRANSACTION_BYTES,
    'Solana transaction'
  )
  const cursor = { offset: 0 }
  const signatureCount = readShortVector(transaction, cursor, 'signature count')
  readBytes(transaction, cursor, signatureCount * SIGNATURE_BYTES, 'signatures')
  if (cursor.offset === transaction.byteLength) throw new Error('Solana transaction has no message')
  return parseMessage(transaction.subarray(cursor.offset))
}
