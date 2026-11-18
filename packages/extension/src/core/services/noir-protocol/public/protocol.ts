import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { encodeBase58, parseNearBase58 } from '@/core/chains/near/identifiers'

import type { NoirPublicFunctionCallRequest } from './types'

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const PUBLIC_KEY = /^04[0-9a-f]{128}$/
const COMPACT_SIGNATURE = /^[0-9a-fA-F]{130}$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_SIGNATURE = /^(?:0x)?[0-9a-fA-F]{128}(?:1b|1c)$/i
const MAX_ACTIONS = 16
const MAX_CALLS = 16
const MAX_ARGS_BYTES = 32 * 1024
const MAX_BODY_BYTES = 64 * 1024
const U128_MAX = (1n << 128n) - 1n
const MIN_TGAS = 31
const MAX_TGAS = 1000
const textEncoder = new TextEncoder()

// Match Go's encoding/json escaping for the submitted RawMessage bytes used in
// the submission ID. Business signing uses the contract's serde_json order.
export function stringifyPublicWire(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('Invalid Public JSON value')
  return json.replace(/[<>&\u2028\u2029]/g, character => {
    switch (character) {
      case '<':
        return '\\u003c'
      case '>':
        return '\\u003e'
      case '&':
        return '\\u0026'
      case '\u2028':
        return '\\u2028'
      default:
        return '\\u2029'
    }
  })
}

export interface NoirPublicTxCandidate {
  readonly tgas?: number
  readonly address: string
  readonly nonce: string
  readonly deadline: string
  readonly tx_requests: readonly NoirPublicFunctionCallRequest[]
  readonly signer_wallet: NoirPublicSignerWallet
  readonly signature: string
}

export type NoirPublicIdentityChain = 'zcash' | 'evm'
export type NoirPublicSignerWallet = Readonly<{ Zcash: string }> | Readonly<{ EVM: string }>

export function readPublicTgas(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < MIN_TGAS ||
    (value as number) > MAX_TGAS
  ) {
    throw new Error('Public tgas must be an integer from 31 to 1000')
  }
  return value as number
}

export interface NoirPublicBusiness {
  readonly nonce: string
  readonly deadline: string
  readonly tx_requests: readonly NoirPublicFunctionCallRequest[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    throw new Error(`Invalid ${label} fields`)
  }
}

export function readPublicDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

export function readPublicAccountId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

export function readPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !PUBLIC_KEY.test(value)) {
    throw new Error('Invalid Public Zcash uncompressed public key')
  }
  return value
}

export function readPublicEvmAddress(value: unknown): string {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) {
    throw new Error('Invalid Public EVM address')
  }
  return value.toLowerCase()
}

export function readPublicIdentity(
  value: unknown,
  chain: NoirPublicIdentityChain = 'zcash'
): string {
  if (chain === 'evm') return readPublicEvmAddress(value)
  if (chain === 'zcash') return readPublicKey(value)
  throw new Error('Invalid Public identity chain')
}

export function createPublicSignerWallet(
  identity: unknown,
  chain: NoirPublicIdentityChain = 'zcash'
): NoirPublicSignerWallet {
  const value = readPublicIdentity(identity, chain)
  return chain === 'evm' ? Object.freeze({ EVM: value.slice(2) }) : Object.freeze({ Zcash: value })
}

export function parsePublicSignerWallet(value: unknown): NoirPublicSignerWallet {
  const wallet = record(value, 'Public signer wallet')
  if (Object.keys(wallet).length !== 1) throw new Error('Invalid Public signer wallet fields')
  if ('EVM' in wallet) {
    if (typeof wallet.EVM !== 'string' || !/^[0-9a-f]{40}$/.test(wallet.EVM)) {
      throw new Error('Invalid Public EVM signer wallet')
    }
    return Object.freeze({ EVM: wallet.EVM })
  }
  exactKeys(wallet, ['Zcash'], 'Public signer wallet')
  return Object.freeze({ Zcash: readPublicKey(wallet.Zcash) })
}

export function readPublicEvmSignature(value: unknown): string {
  if (typeof value !== 'string' || !EVM_SIGNATURE.test(value)) {
    throw new Error('Invalid Public EVM signature')
  }
  return value.replace(/^0x/i, '').toLowerCase()
}

export function readPublicIdentitySignature(
  value: unknown,
  chain: NoirPublicIdentityChain = 'zcash'
): string {
  if (chain === 'evm') return readPublicEvmSignature(value)
  if (chain === 'zcash') return readPublicSignature(value)
  throw new Error('Invalid Public identity chain')
}

export function readPublicSignature(value: unknown): string {
  if (typeof value !== 'string' || !COMPACT_SIGNATURE.test(value)) {
    throw new Error('Invalid Public Zcash compact signature')
  }
  const header = Number.parseInt(value.slice(0, 2), 16)
  if (header < 27 || header > 30) throw new Error('Invalid Public Zcash signature header')
  return value.toLowerCase()
}

export function readPublicSubmissionId(value: unknown): string {
  return parseNearBase58(value, 32, 'Public business hash')
}

export function parsePublicFunctionCallRequests(
  input: unknown
): readonly NoirPublicFunctionCallRequest[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_ACTIONS) {
    throw new Error('Invalid Public transaction requests')
  }
  const requests = input.map((item, index): NoirPublicFunctionCallRequest => {
    const outer = record(item, `Public request ${index}`)
    exactKeys(outer, ['FunctionCall'], `Public request ${index}`)
    const action = record(outer.FunctionCall, `Public FunctionCall ${index}`)
    exactKeys(action, ['receiver_id', 'function_calls'], `Public FunctionCall ${index}`)
    const receiver_id = readPublicAccountId(action.receiver_id, 'Public receiver')
    if (
      !Array.isArray(action.function_calls) ||
      action.function_calls.length < 1 ||
      action.function_calls.length > MAX_CALLS
    ) {
      throw new Error('Invalid Public function calls')
    }
    const function_calls = action.function_calls.map((call, callIndex) => {
      const raw = record(call, `Public function call ${callIndex}`)
      exactKeys(raw, ['method_name', 'args', 'gas', 'deposit'], `Public function call ${callIndex}`)
      if (
        typeof raw.method_name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw.method_name)
      ) {
        throw new Error('Invalid Public method name')
      }
      if (typeof raw.args !== 'string' || textEncoder.encode(raw.args).length > MAX_ARGS_BYTES) {
        throw new Error('Invalid Public function arguments')
      }
      try {
        JSON.parse(raw.args)
      } catch {
        throw new Error('Public function arguments must be JSON text')
      }
      // Escape only these raw JSON string characters before embedding args into
      // Business. Go and serde_json otherwise sign different outer JSON bytes.
      const args = raw.args.replace(/[<>&\u2028\u2029]/g, character => {
        switch (character) {
          case '<':
            return '\\u003c'
          case '>':
            return '\\u003e'
          case '&':
            return '\\u0026'
          case '\u2028':
            return '\\u2028'
          default:
            return '\\u2029'
        }
      })
      const gas = readPublicDecimal(raw.gas, 'Public gas')
      const deposit = readPublicDecimal(raw.deposit, 'Public deposit')
      if (BigInt(deposit) > U128_MAX)
        throw new Error('Public deposit exceeds the NEAR contract limit')
      if (gas === '0' || BigInt(gas) > 300_000_000_000_000n) {
        throw new Error('Public gas exceeds the NEAR transaction limit')
      }
      return Object.freeze({ method_name: raw.method_name, args, gas, deposit })
    })
    return Object.freeze({
      FunctionCall: Object.freeze({ receiver_id, function_calls: Object.freeze(function_calls) })
    })
  })
  if (textEncoder.encode(stringifyPublicWire(requests)).length > MAX_BODY_BYTES / 2) {
    throw new Error('Public transaction requests are too large')
  }
  return Object.freeze(requests)
}

export function serializePublicBusiness(input: {
  nonce: unknown
  deadline: unknown
  txRequests: unknown
}): string {
  const business: NoirPublicBusiness = {
    nonce: readPublicDecimal(input.nonce, 'Public nonce'),
    deadline: readPublicDecimal(input.deadline, 'Public deadline'),
    tx_requests: parsePublicFunctionCallRequests(input.txRequests)
  }
  return JSON.stringify(business)
}

export function assertPublicJsonMessage(message: string): void {
  try {
    JSON.parse(message)
  } catch {
    throw new Error('Public signing message must be valid JSON')
  }
}

export function createPublicCandidate(input: {
  tgas: unknown
  address: unknown
  nonce: unknown
  deadline: unknown
  txRequests: unknown
  publicKey: unknown
  signature: unknown
  identityChain?: NoirPublicIdentityChain
}): NoirPublicTxCandidate {
  const chain = input.identityChain ?? 'zcash'
  const candidate: NoirPublicTxCandidate = Object.freeze({
    tgas: readPublicTgas(input.tgas),
    address: readPublicAccountId(input.address, 'Public MCA address'),
    nonce: readPublicDecimal(input.nonce, 'Public nonce'),
    deadline: readPublicDecimal(input.deadline, 'Public deadline'),
    tx_requests: parsePublicFunctionCallRequests(input.txRequests),
    signer_wallet: createPublicSignerWallet(input.publicKey, chain),
    signature: readPublicIdentitySignature(input.signature, chain)
  })
  if (textEncoder.encode(stringifyPublicWire(candidate)).length > MAX_BODY_BYTES) {
    throw new Error('Public submission is too large')
  }
  return candidate
}

export function parsePublicCandidate(value: unknown): NoirPublicTxCandidate {
  const candidate = record(value, 'Public candidate')
  exactKeys(
    candidate,
    [
      ...(candidate.tgas === undefined ? [] : ['tgas']),
      'address',
      'nonce',
      'deadline',
      'tx_requests',
      'signer_wallet',
      'signature'
    ],
    'Public candidate'
  )
  const wallet = parsePublicSignerWallet(candidate.signer_wallet)
  const chain: NoirPublicIdentityChain = 'EVM' in wallet ? 'evm' : 'zcash'
  const fields = {
    address: candidate.address,
    nonce: candidate.nonce,
    deadline: candidate.deadline,
    txRequests: candidate.tx_requests,
    publicKey: 'EVM' in wallet ? `0x${wallet.EVM}` : wallet.Zcash,
    identityChain: chain,
    signature: candidate.signature
  }
  if (candidate.tgas !== undefined)
    return createPublicCandidate({ ...fields, tgas: candidate.tgas })
  const legacy: NoirPublicTxCandidate = Object.freeze({
    address: readPublicAccountId(fields.address, 'Public MCA address'),
    nonce: readPublicDecimal(fields.nonce, 'Public nonce'),
    deadline: readPublicDecimal(fields.deadline, 'Public deadline'),
    tx_requests: parsePublicFunctionCallRequests(fields.txRequests),
    signer_wallet: createPublicSignerWallet(fields.publicKey, chain),
    signature: readPublicIdentitySignature(fields.signature, chain)
  })
  if (textEncoder.encode(stringifyPublicWire(legacy)).length > MAX_BODY_BYTES) {
    throw new Error('Public submission is too large')
  }
  return legacy
}

export function serializePublicCandidate(candidate: NoirPublicTxCandidate): string {
  return stringifyPublicWire(parsePublicCandidate(candidate))
}

export function createPublicMcaMessage(
  publicKey: unknown,
  signature: unknown,
  identityChain: NoirPublicIdentityChain = 'zcash'
): string {
  return JSON.stringify({
    w: [createPublicSignerWallet(publicKey, identityChain)],
    s: [readPublicIdentitySignature(signature, identityChain)]
  })
}

export function computeLegacyPublicSubmissionId(candidate: NoirPublicTxCandidate): string {
  const parsed = parsePublicCandidate(candidate)
  const fields = [
    parsed.address,
    parsed.nonce,
    parsed.deadline,
    stringifyPublicWire(parsed.tx_requests),
    stringifyPublicWire(parsed.signer_wallet),
    parsed.signature,
    ...(parsed.tgas === undefined ? [] : [String(parsed.tgas)])
  ]
  const parts: Uint8Array[] = [
    textEncoder.encode(
      parsed.tgas === undefined ? 'NOIR_PUBLIC_SUBMISSION_V1\0' : 'NOIR_PUBLIC_SUBMISSION_V2\0'
    )
  ]
  for (const field of fields) {
    const bytes = textEncoder.encode(field)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  const total = parts.reduce((size, part) => size + part.length, 0)
  const payload = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    payload.set(part, offset)
    offset += part.length
  }
  return bytesToHex(sha256(payload))
}

// Canonicalization is for the backend identifier only; never change signing bytes.
function canonicalPublicJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPublicJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${stringifyPublicWire(key)}:${canonicalPublicJson(field)}`)
      .join(',')}}`
  }
  return stringifyPublicWire(value)
}

export function computePublicSubmissionId(candidate: NoirPublicTxCandidate): string {
  const parsed = parsePublicCandidate(candidate)
  if (parsed.tgas === undefined) return computeLegacyPublicSubmissionId(parsed)
  const parts = [textEncoder.encode('NOIR_INTENT_ID_V1\0')]
  for (const field of ['mainnet', 'public', canonicalPublicJson(parsed)]) {
    const bytes = textEncoder.encode(field)
    const size = new Uint8Array(8)
    new DataView(size.buffer).setBigUint64(0, BigInt(bytes.length), false)
    parts.push(size, bytes)
  }
  const payload = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    payload.set(part, offset)
    offset += part.length
  }
  return encodeBase58(sha256(payload))
}
