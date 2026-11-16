import type { BitcoinTransactionStatus } from '@/core/chains/bitcoin'
import { BitcoinRpcError } from './bitcoin-esplora-error'

const MAXIMUM_HISTORY_TRANSACTIONS = 75
const MAXIMUM_TRANSACTION_INPUTS = 10_000
const MAXIMUM_TRANSACTION_OUTPUTS = 10_000
const MAXIMUM_SCRIPT_BYTES = 1_000_000
const MAXIMUM_WITNESS_ITEMS = 1_000
const MAXIMUM_MONEY_SATS = 2_100_000_000_000_000
const MAXIMUM_BLOCK_HEIGHT = 2_147_483_647
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

export interface BitcoinHistoryOutput {
  readonly address?: string
  readonly valueRaw: string
}

export interface BitcoinHistoryInput {
  readonly coinbase: boolean
  readonly previousOutput: BitcoinHistoryOutput | null
}

export interface BitcoinHistoryTransaction {
  readonly transactionId: string
  readonly feeRaw: string
  readonly inputs: readonly BitcoinHistoryInput[]
  readonly outputs: readonly BitcoinHistoryOutput[]
  readonly status: BitcoinTransactionStatus
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function invalid(label: string): never {
  throw new BitcoinRpcError('invalid-response', `Invalid ${label}`)
}

function parseSafeInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return invalid(label)
  }
  return value as number
}

function parseTransactionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return invalid(label)
  return value
}

function parseBoundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength || CONTROL_CHARACTERS.test(value)) {
    return invalid(label)
  }
  return value
}

function parseHex(value: unknown, label: string): string {
  const parsed = parseBoundedString(value, label, MAXIMUM_SCRIPT_BYTES * 2)
  if (!/^(?:[0-9a-f]{2})*$/.test(parsed)) return invalid(label)
  return parsed
}

function parseAddress(value: unknown, label: string): string {
  const parsed = parseBoundedString(value, label, 128)
  if (parsed.length === 0 || parsed.trim() !== parsed) return invalid(label)
  return parsed
}

function parseStatus(value: unknown): BitcoinTransactionStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['confirmed'], ['block_height', 'block_hash', 'block_time']) ||
    typeof value.confirmed !== 'boolean'
  ) {
    return invalid('Bitcoin history transaction status')
  }
  if (!value.confirmed) {
    if (
      value.block_height !== undefined ||
      value.block_hash !== undefined ||
      value.block_time !== undefined
    ) {
      return invalid('unconfirmed Bitcoin history transaction status')
    }
    return Object.freeze({ confirmed: false })
  }
  return Object.freeze({
    confirmed: true,
    blockHeight: parseSafeInteger(
      value.block_height,
      'Bitcoin history block height',
      MAXIMUM_BLOCK_HEIGHT
    ),
    blockHash: parseTransactionId(value.block_hash, 'Bitcoin history block hash'),
    ...(value.block_time === undefined
      ? {}
      : { blockTime: parseSafeInteger(value.block_time, 'Bitcoin history block time') })
  })
}

function parseOutput(value: unknown, label: string): BitcoinHistoryOutput {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['scriptpubkey', 'scriptpubkey_asm', 'scriptpubkey_type', 'value'],
      ['scriptpubkey_address']
    )
  ) {
    return invalid(label)
  }
  parseHex(value.scriptpubkey, `${label} script`)
  parseBoundedString(value.scriptpubkey_asm, `${label} script assembly`, MAXIMUM_SCRIPT_BYTES)
  const scriptType = parseBoundedString(value.scriptpubkey_type, `${label} script type`, 64)
  if (!/^[a-z0-9_]+$/.test(scriptType)) return invalid(`${label} script type`)
  return Object.freeze({
    ...(value.scriptpubkey_address === undefined
      ? {}
      : { address: parseAddress(value.scriptpubkey_address, `${label} address`) }),
    valueRaw: parseSafeInteger(value.value, `${label} value`, MAXIMUM_MONEY_SATS).toString()
  })
}

function parseWitness(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > MAXIMUM_WITNESS_ITEMS) return invalid(label)
  value.forEach((item, index) => parseHex(item, `${label} item ${index}`))
}

function parseInput(value: unknown, index: number): BitcoinHistoryInput {
  const label = `Bitcoin history input ${index}`
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['txid', 'vout', 'prevout', 'scriptsig', 'scriptsig_asm', 'is_coinbase', 'sequence'],
      ['witness', 'inner_redeemscript_asm', 'inner_witnessscript_asm']
    ) ||
    typeof value.is_coinbase !== 'boolean'
  ) {
    return invalid(label)
  }
  parseTransactionId(value.txid, `${label} transaction ID`)
  parseSafeInteger(value.vout, `${label} output index`, 0xffffffff)
  parseHex(value.scriptsig, `${label} script`)
  parseBoundedString(value.scriptsig_asm, `${label} script assembly`, MAXIMUM_SCRIPT_BYTES)
  parseSafeInteger(value.sequence, `${label} sequence`, 0xffffffff)
  if (value.witness !== undefined) parseWitness(value.witness, `${label} witness`)
  if (value.inner_redeemscript_asm !== undefined) {
    parseBoundedString(
      value.inner_redeemscript_asm,
      `${label} inner redeem script`,
      MAXIMUM_SCRIPT_BYTES
    )
  }
  if (value.inner_witnessscript_asm !== undefined) {
    parseBoundedString(
      value.inner_witnessscript_asm,
      `${label} inner witness script`,
      MAXIMUM_SCRIPT_BYTES
    )
  }
  if (value.is_coinbase) {
    if (value.prevout !== null) return invalid(`${label} coinbase previous output`)
    return Object.freeze({ coinbase: true, previousOutput: null })
  }
  if (value.prevout === null) return invalid(`${label} previous output`)
  return Object.freeze({
    coinbase: false,
    previousOutput: parseOutput(value.prevout, `${label} previous output`)
  })
}

function parseTransaction(value: unknown, index: number): BitcoinHistoryTransaction {
  const label = `Bitcoin history transaction ${index}`
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['txid', 'version', 'locktime', 'size', 'weight', 'fee', 'vin', 'vout', 'status'],
      ['sigops']
    ) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < -0x80000000 ||
    value.version > 0x7fffffff ||
    !Array.isArray(value.vin) ||
    value.vin.length === 0 ||
    value.vin.length > MAXIMUM_TRANSACTION_INPUTS ||
    !Array.isArray(value.vout) ||
    value.vout.length === 0 ||
    value.vout.length > MAXIMUM_TRANSACTION_OUTPUTS
  ) {
    return invalid(label)
  }
  parseSafeInteger(value.locktime, `${label} locktime`, 0xffffffff)
  parseSafeInteger(value.size, `${label} size`, 4_000_000)
  parseSafeInteger(value.weight, `${label} weight`, 16_000_000)
  if (value.sigops !== undefined) {
    parseSafeInteger(value.sigops, `${label} signature operations`, 1_000_000)
  }
  const feeRaw = parseSafeInteger(value.fee, `${label} fee`, MAXIMUM_MONEY_SATS).toString()
  const inputs = Object.freeze(value.vin.map((input, inputIndex) => parseInput(input, inputIndex)))
  const outputs = Object.freeze(
    value.vout.map((output, outputIndex) => parseOutput(output, `${label} output ${outputIndex}`))
  )
  const coinbase = inputs.some(input => input.coinbase)
  if (
    coinbase !== inputs.every(input => input.coinbase) ||
    (coinbase && (inputs.length !== 1 || feeRaw !== '0'))
  ) {
    return invalid(`${label} coinbase accounting`)
  }
  if (!coinbase) {
    const inputValue = inputs.reduce((sum, input) => {
      if (input.previousOutput === null) return invalid(`${label} previous output accounting`)
      return sum + BigInt(input.previousOutput.valueRaw)
    }, 0n)
    const outputValue = outputs.reduce((sum, output) => sum + BigInt(output.valueRaw), 0n)
    if (inputValue - outputValue !== BigInt(feeRaw)) {
      return invalid(`${label} fee accounting`)
    }
  }
  return Object.freeze({
    transactionId: parseTransactionId(value.txid, `${label} transaction ID`),
    feeRaw,
    inputs,
    outputs,
    status: parseStatus(value.status)
  })
}

export function parseBitcoinAddressHistory(value: unknown): readonly BitcoinHistoryTransaction[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_HISTORY_TRANSACTIONS) {
    return invalid('Bitcoin address history response')
  }
  const transactions = Object.freeze(value.map(parseTransaction))
  if (
    new Set(transactions.map(transaction => transaction.transactionId)).size !== transactions.length
  ) {
    return invalid('duplicate Bitcoin address history transaction')
  }
  return transactions
}
