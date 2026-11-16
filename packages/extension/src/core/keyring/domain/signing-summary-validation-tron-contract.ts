import bs58check from 'bs58check'

import type {
  TronContractSummary,
  TronSmartContractInterpretation,
  TronVoteSummary
} from './signing-summary'
import {
  assertExactKeys,
  readArray,
  readBoolean,
  readCanonicalContent,
  readHex,
  readLiteral,
  readRecord,
  readUnsignedDecimal
} from './signing-summary-validation'

const MAX_I64 = '9223372036854775807'
export const TRON_MAX_U256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const TRON_MAX_VOTES = 30
const TRON_CONTRACT_TYPES = [
  'transfer',
  'transfer-asset',
  'vote-witness',
  'trigger-smart-contract',
  'freeze-balance-v2',
  'unfreeze-balance-v2',
  'withdraw-expire-unfreeze',
  'delegate-resource',
  'undelegate-resource',
  'cancel-all-unfreeze-v2'
] as const

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function decodeTronAddress(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
    throw new Error(`${label} must be a canonical TRON Base58Check address`)
  }
  const decoded = bs58check.decodeUnsafe(value)
  if (decoded === undefined || decoded.length !== 21 || decoded[0] !== 0x41) {
    throw new Error(`${label} must encode a checksummed 21-byte TRON address`)
  }
  return decoded
}

export function readTronAddress(value: unknown, label: string): string {
  decodeTronAddress(value, label)
  return value as string
}

function tronAddressPayloadHex(address: string): string {
  return bytesToHex(decodeTronAddress(address, 'TRON address').slice(1))
}

export function readTronUint(value: unknown, label: string, maximum = MAX_I64): string {
  const parsed = readUnsignedDecimal(value, label)
  if (parsed.length > maximum.length || (parsed.length === maximum.length && parsed > maximum)) {
    throw new Error(`${label} exceeds its supported unsigned range`)
  }
  return parsed
}

function readPositiveUint(value: unknown, label: string): string {
  const parsed = readTronUint(value, label)
  if (parsed === '0') throw new Error(`${label} must be positive`)
  return parsed
}

function readU256(value: unknown, label: string): string {
  return readTronUint(value, label, TRON_MAX_U256)
}

function readVote(value: unknown, index: number): TronVoteSummary {
  const label = `TronTransactionSummary.fields.contract.votes[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(record, ['voteAddress', 'voteCount'], [], label)
  return Object.freeze({
    voteAddress: readTronAddress(record.voteAddress, `${label}.voteAddress`),
    voteCount: readPositiveUint(record.voteCount, `${label}.voteCount`)
  })
}

function assertAbiAddress(word: string, address: string, label: string): void {
  if (!/^0{24}[0-9a-f]{40}$/.test(word) || word.slice(24) !== tronAddressPayloadHex(address)) {
    throw new Error(`${label} does not match the TRON address interpretation`)
  }
}

function assertAbiUint(word: string, value: string, label: string): void {
  if (BigInt(`0x${word}`).toString() !== value) {
    throw new Error(`${label} does not match the uint256 interpretation`)
  }
}

function readSmartContractInterpretation(
  value: unknown,
  label: string,
  calldataHex: string,
  calldataBytes: number
): TronSmartContractInterpretation {
  const record = readRecord(value, label)
  const kind = readLiteral(
    record.kind,
    ['trc20-transfer', 'trc20-approve', 'trc20-transfer-from', 'unrecognized'],
    `${label}.kind`
  )
  if (kind === 'unrecognized') {
    assertExactKeys(record, ['kind'], [], label)
    return Object.freeze({ kind })
  }

  const words = calldataHex.slice(10).match(/.{64}/g) ?? []
  if (kind === 'trc20-transfer' || kind === 'trc20-approve') {
    const addressField = kind === 'trc20-transfer' ? 'to' : 'spender'
    const selector = kind === 'trc20-transfer' ? '0xa9059cbb' : '0x095ea7b3'
    assertExactKeys(record, ['kind', addressField, 'amountRaw'], [], label)
    if (calldataBytes !== 68 || calldataHex.slice(0, 10) !== selector || words.length !== 2) {
      throw new Error(`${label} does not match canonical ${kind} calldata`)
    }
    const address = readTronAddress(record[addressField], `${label}.${addressField}`)
    const amountRaw = readU256(record.amountRaw, `${label}.amountRaw`)
    assertAbiAddress(words[0], address, `${label}.${addressField}`)
    assertAbiUint(words[1], amountRaw, `${label}.amountRaw`)
    return Object.freeze(
      kind === 'trc20-transfer'
        ? { kind, to: address, amountRaw }
        : { kind, spender: address, amountRaw }
    )
  }

  assertExactKeys(record, ['kind', 'from', 'to', 'amountRaw'], [], label)
  if (calldataBytes !== 100 || calldataHex.slice(0, 10) !== '0x23b872dd' || words.length !== 3) {
    throw new Error(`${label} does not match canonical trc20-transfer-from calldata`)
  }
  const from = readTronAddress(record.from, `${label}.from`)
  const to = readTronAddress(record.to, `${label}.to`)
  const amountRaw = readU256(record.amountRaw, `${label}.amountRaw`)
  assertAbiAddress(words[0], from, `${label}.from`)
  assertAbiAddress(words[1], to, `${label}.to`)
  assertAbiUint(words[2], amountRaw, `${label}.amountRaw`)
  return Object.freeze({ kind, from, to, amountRaw })
}

function readTriggerSmartContract(
  record: Record<string, unknown>,
  label: string
): TronContractSummary {
  assertExactKeys(
    record,
    [
      'type',
      'owner',
      'contractAddress',
      'callValueSun',
      'callTokenValue',
      'tokenId',
      'calldata',
      'methodSelector',
      'interpretation'
    ],
    [],
    label
  )
  const calldata = readCanonicalContent(record.calldata, `${label}.calldata`)
  if (calldata.encoding !== 'hex') throw new Error('TRON calldata must use canonical hex')
  const derivedSelector = calldata.byteLength >= 4 ? calldata.value.slice(0, 10) : null
  const methodSelector =
    record.methodSelector === null
      ? null
      : readHex(record.methodSelector, `${label}.methodSelector`, { bytes: 4 })
  if (methodSelector !== derivedSelector) {
    throw new Error('TRON method selector does not match calldata')
  }
  return Object.freeze({
    type: 'trigger-smart-contract',
    owner: readTronAddress(record.owner, `${label}.owner`),
    contractAddress: readTronAddress(record.contractAddress, `${label}.contractAddress`),
    callValueSun: readTronUint(record.callValueSun, `${label}.callValueSun`),
    callTokenValue: readTronUint(record.callTokenValue, `${label}.callTokenValue`),
    tokenId: readTronUint(record.tokenId, `${label}.tokenId`),
    calldata,
    methodSelector,
    interpretation: readSmartContractInterpretation(
      record.interpretation,
      `${label}.interpretation`,
      calldata.value,
      calldata.byteLength
    )
  })
}

export function readTronContract(value: unknown): TronContractSummary {
  const label = 'TronTransactionSummary.fields.contract'
  const record = readRecord(value, label)
  const type = readLiteral(record.type, TRON_CONTRACT_TYPES, `${label}.type`)
  const owner = () => readTronAddress(record.owner, `${label}.owner`)
  const resource = () => readLiteral(record.resource, ['bandwidth', 'energy'], `${label}.resource`)
  switch (type) {
    case 'transfer':
      assertExactKeys(record, ['type', 'owner', 'to', 'amountSun'], [], label)
      return Object.freeze({
        type,
        owner: owner(),
        to: readTronAddress(record.to, `${label}.to`),
        amountSun: readPositiveUint(record.amountSun, `${label}.amountSun`)
      })
    case 'transfer-asset': {
      assertExactKeys(record, ['type', 'owner', 'to', 'assetName', 'amountRaw'], [], label)
      const assetName = readCanonicalContent(record.assetName, `${label}.assetName`)
      if (assetName.byteLength === 0 || assetName.encoding === 'base64') {
        throw new Error('TRC-10 asset name must use non-empty utf8 or hex content')
      }
      return Object.freeze({
        type,
        owner: owner(),
        to: readTronAddress(record.to, `${label}.to`),
        assetName,
        amountRaw: readPositiveUint(record.amountRaw, `${label}.amountRaw`)
      })
    }
    case 'vote-witness': {
      assertExactKeys(record, ['type', 'owner', 'votes'], [], label)
      const votes = readArray(record.votes, `${label}.votes`, readVote, {
        maximum: TRON_MAX_VOTES
      })
      if (new Set(votes.map(vote => vote.voteAddress)).size !== votes.length) {
        throw new Error('TRON vote addresses must be unique')
      }
      return Object.freeze({ type, owner: owner(), votes })
    }
    case 'trigger-smart-contract':
      return readTriggerSmartContract(record, label)
    case 'freeze-balance-v2':
    case 'unfreeze-balance-v2':
      assertExactKeys(record, ['type', 'owner', 'resource', 'amountSun'], [], label)
      return Object.freeze({
        type,
        owner: owner(),
        resource: resource(),
        amountSun: readPositiveUint(record.amountSun, `${label}.amountSun`)
      })
    case 'withdraw-expire-unfreeze':
    case 'cancel-all-unfreeze-v2':
      assertExactKeys(record, ['type', 'owner'], [], label)
      return Object.freeze({ type, owner: owner() })
    case 'delegate-resource': {
      assertExactKeys(
        record,
        ['type', 'owner', 'receiver', 'resource', 'amountSun', 'locked', 'lockPeriod'],
        [],
        label
      )
      const locked = readBoolean(record.locked, `${label}.locked`)
      const lockPeriod = readTronUint(record.lockPeriod, `${label}.lockPeriod`)
      if (!locked && lockPeriod !== '0') {
        throw new Error('Unlocked TRON delegation must have a zero lock period')
      }
      return Object.freeze({
        type,
        owner: owner(),
        receiver: readTronAddress(record.receiver, `${label}.receiver`),
        resource: resource(),
        amountSun: readPositiveUint(record.amountSun, `${label}.amountSun`),
        locked,
        lockPeriod
      })
    }
    case 'undelegate-resource':
      assertExactKeys(record, ['type', 'owner', 'receiver', 'resource', 'amountSun'], [], label)
      return Object.freeze({
        type,
        owner: owner(),
        receiver: readTronAddress(record.receiver, `${label}.receiver`),
        resource: resource(),
        amountSun: readPositiveUint(record.amountSun, `${label}.amountSun`)
      })
  }
}
