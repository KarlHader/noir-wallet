import {
  DASH_INSIGHT_TX_PAGE_LENGTH,
  DASH_MAX_MONEY_DUFFS,
  parseDashDecimalToDuffs,
  resolveDashRelayFeeDuffsPerKb,
  type DashInsightNetworkIdentity
} from './config'

export const DASH_RPC_ERROR_CODES = Object.freeze([
  'cancelled',
  'timeout',
  'network-unavailable',
  'rate-limited',
  'unauthorized',
  'not-found',
  'invalid-response',
  'chain-mismatch'
] as const)

export type DashRpcErrorCode = (typeof DASH_RPC_ERROR_CODES)[number]

export class DashRpcError extends Error {
  readonly code: DashRpcErrorCode
  readonly retryAfterMs?: number

  constructor(code: DashRpcErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'DashRpcError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

export interface DashUtxo {
  readonly address: string
  readonly transactionId: string
  readonly outputIndex: number
  readonly scriptHex: string
  readonly valueDuffs: string
  readonly confirmations: number
  readonly height?: number
  readonly timestamp?: number
}

export interface DashTransactionInput {
  readonly previousTransactionId?: string
  readonly outputIndex?: number
  readonly sequence: number
  readonly index: number
  readonly address?: string
  readonly valueDuffs?: string
  readonly coinbase?: string
}

export interface DashTransactionOutput {
  readonly index: number
  readonly valueDuffs: string
  readonly scriptHex: string
  readonly addresses: readonly string[]
  readonly spentTransactionId: string | null
  readonly spentIndex: number | null
  readonly spentHeight: number | null
}

export interface DashTransaction {
  readonly transactionId: string
  readonly version: number
  /** DIP2 special transaction type. Standard transactions are 0, including responses that omit `type`. */
  readonly type: number
  readonly locktime: number
  readonly sizeBytes: number
  readonly confirmations: number
  readonly blockHash: string | null
  readonly blockHeight: number | null
  readonly time: number
  readonly blockTime?: number
  readonly txlock: boolean
  readonly isCoinbase: boolean
  readonly inputs: readonly DashTransactionInput[]
  readonly outputs: readonly DashTransactionOutput[]
  readonly valueOutDuffs: string
  readonly feeDuffs?: string
}

export interface DashAddressTransactionPage {
  readonly pagesTotal: number
  readonly transactions: readonly DashTransaction[]
}

export interface DashInsightStatus {
  readonly blocks: number
  readonly network: string
  readonly testnet: boolean
  readonly relayFeeDuffsPerKb: string
}

const MAXIMUM_BLOCK_HEIGHT = 2_147_483_647
const MAXIMUM_VECTOR = 10_000
const MAXIMUM_TEXT = 1_024
const MAXIMUM_SCRIPT_HEX_CHARS = 20_000
const MAXIMUM_RAW_TRANSACTION_HEX_CHARS = 2_000_000
const TXID = /^[0-9a-f]{64}$/
const HEX = /^[0-9a-f]*$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(
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

function invalid(label: string): DashRpcError {
  return new DashRpcError('invalid-response', `Invalid ${label}`)
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TXID.test(value)) throw invalid(label)
  return value
}

function parseSafeInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw invalid(label)
  }
  return value as number
}

function parseUint32(value: unknown, label: string): number {
  return parseSafeInteger(value, label, 0xffffffff)
}

function parseHex(value: unknown, label: string, maximumChars: number): string {
  if (typeof value !== 'string' || value.length > maximumChars || value.length % 2 !== 0) {
    throw invalid(label)
  }
  const normalized = value.toLowerCase()
  if (!HEX.test(normalized)) throw invalid(label)
  return normalized
}

function parseText(value: unknown, label: string, maximum = MAXIMUM_TEXT): string {
  if (typeof value !== 'string' || value.length > maximum) throw invalid(label)
  return value
}

function duffsToString(value: bigint, label: string): string {
  if (value < 0n || value > DASH_MAX_MONEY_DUFFS) throw invalid(label)
  return value.toString()
}

function parseIntegerDuffs(value: unknown, label: string): string {
  return duffsToString(BigInt(parseSafeInteger(value, label, Number(DASH_MAX_MONEY_DUFFS))), label)
}

function parseDecimalDuffs(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(label)
  try {
    return duffsToString(parseDashDecimalToDuffs(value), label)
  } catch (error) {
    if (error instanceof DashRpcError) throw error
    throw invalid(label)
  }
}

function parseAmount(value: unknown, satoshis: unknown, label: string): string {
  if (satoshis !== undefined) return parseIntegerDuffs(satoshis, `${label} satoshis`)
  return parseDecimalDuffs(value, label)
}

function readJsonStringEnd(source: string, quoteIndex: number): number {
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === '"') return index
  }
  throw invalid('Dash Insight JSON')
}

/** Reads the raw JSON number or string for one object key, without using the parsed float. */
export function readJsonScalarLiteral(source: string, key: string): string {
  let occurrences = 0
  let literal = ''
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '"') continue
    const end = readJsonStringEnd(source, index)
    const raw = source.slice(index + 1, end)
    const escaped = raw.includes('\\')
    index = end
    if (escaped || raw !== key) continue
    let cursor = index + 1
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
    if (source[cursor] !== ':') continue
    cursor += 1
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
    const start = cursor
    if (source[cursor] === '"') {
      const valueEnd = readJsonStringEnd(source, cursor)
      literal = source.slice(cursor + 1, valueEnd)
      if (literal.includes('\\')) throw invalid('Dash relay fee')
      cursor = valueEnd
    } else {
      if (source[cursor] === '-') cursor += 1
      if (!/[0-9]/.test(source[cursor] ?? '')) throw invalid('Dash relay fee')
      while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor += 1
      if (source[cursor] === '.') {
        cursor += 1
        if (!/[0-9]/.test(source[cursor] ?? '')) throw invalid('Dash relay fee')
        while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor += 1
      }
      if (source[cursor] === 'e' || source[cursor] === 'E') {
        cursor += 1
        if (source[cursor] === '+' || source[cursor] === '-') cursor += 1
        while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor += 1
      }
      literal = source.slice(start, cursor)
    }
    occurrences += 1
    index = cursor
  }
  if (occurrences !== 1) throw invalid('Dash relay fee')
  return literal
}

export function parseDashBlockIndex(value: unknown, genesisHash: string): void {
  if (!isRecord(value) || !hasExactKeys(value, ['blockHash'])) {
    throw invalid('Dash block index')
  }
  if (parseHash(value.blockHash, 'Dash genesis block hash') !== genesisHash) {
    throw new DashRpcError('chain-mismatch', 'Dash RPC endpoint returned the wrong chain')
  }
}

function resolveDashInsightTestnet(network: string, testnet: unknown): boolean {
  const derived = network === 'livenet' ? false : network === 'testnet' ? true : undefined
  if (testnet === undefined) {
    if (derived === undefined) throw invalid('Dash testnet flag')
    return derived
  }
  if (typeof testnet !== 'boolean') throw invalid('Dash testnet flag')
  if (derived !== undefined && testnet !== derived) throw invalid('Dash testnet flag')
  return testnet
}

export function parseDashInsightStatus(text: string): DashInsightStatus {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalid('Dash network status')
  }
  if (!isRecord(value) || !hasExactKeys(value, ['info'])) throw invalid('Dash network status')
  const info = value.info
  if (
    !isRecord(info) ||
    !hasExactKeys(
      info,
      [
        'version',
        'insightversion',
        'protocolversion',
        'blocks',
        'timeoffset',
        'connections',
        'difficulty',
        'relayfee',
        'errors',
        'network'
      ],
      ['proxy', 'testnet']
    )
  ) {
    throw invalid('Dash network status')
  }
  parseSafeInteger(info.version, 'Dash version')
  if (info.insightversion !== null) parseText(info.insightversion, 'Dash Insight version', 64)
  parseSafeInteger(info.protocolversion, 'Dash protocol version')
  const blocks = parseSafeInteger(info.blocks, 'Dash tip height', MAXIMUM_BLOCK_HEIGHT)
  if (!Number.isSafeInteger(info.timeoffset)) throw invalid('Dash time offset')
  parseSafeInteger(info.connections, 'Dash connection count', 1_000_000)
  if (info.proxy !== undefined) parseText(info.proxy, 'Dash proxy', 256)
  if (typeof info.difficulty !== 'number' || !Number.isFinite(info.difficulty)) {
    throw invalid('Dash difficulty')
  }
  parseText(info.errors, 'Dash warnings')
  if (typeof info.network !== 'string' || !/^[a-z0-9-]{1,32}$/.test(info.network)) {
    throw invalid('Dash network name')
  }
  const testnet = resolveDashInsightTestnet(info.network, info.testnet)
  let relayFeeDuffsPerKb: bigint
  try {
    relayFeeDuffsPerKb = resolveDashRelayFeeDuffsPerKb(readJsonScalarLiteral(text, 'relayfee'))
  } catch (error) {
    if (error instanceof DashRpcError) throw error
    throw invalid('Dash relay fee')
  }
  return Object.freeze({
    blocks,
    network: info.network,
    testnet,
    relayFeeDuffsPerKb: relayFeeDuffsPerKb.toString()
  })
}

export function assertDashInsightNetwork(
  status: DashInsightStatus,
  expected: DashInsightNetworkIdentity
): void {
  if (status.network !== expected.insightNetwork || status.testnet !== expected.testnet) {
    throw new DashRpcError('chain-mismatch', 'Dash RPC endpoint returned the wrong network')
  }
}

function parseUtxo(value: unknown, index: number, allowedAddresses: ReadonlySet<string>): DashUtxo {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['address', 'txid', 'vout', 'scriptPubKey', 'amount', 'confirmations'],
      ['satoshis', 'height', 'ts']
    )
  ) {
    throw invalid(`Dash UTXO ${index}`)
  }
  const address = parseText(value.address, `Dash UTXO ${index} address`, 128)
  if (!allowedAddresses.has(address)) throw invalid(`Dash UTXO ${index} address`)
  const hasSatoshis = Object.prototype.hasOwnProperty.call(value, 'satoshis')
  if (!hasSatoshis && typeof value.amount !== 'string') {
    throw invalid(`Dash UTXO ${index} amount`)
  }
  if (hasSatoshis && typeof value.amount !== 'number' && typeof value.amount !== 'string') {
    throw invalid(`Dash UTXO ${index} amount`)
  }
  if (typeof value.amount === 'number' && !Number.isFinite(value.amount)) {
    throw invalid(`Dash UTXO ${index} amount`)
  }
  const parsed: DashUtxo = {
    address,
    transactionId: parseHash(value.txid, `Dash UTXO ${index} transaction ID`),
    outputIndex: parseUint32(value.vout, `Dash UTXO ${index} output index`),
    scriptHex: parseHex(value.scriptPubKey, `Dash UTXO ${index} script`, MAXIMUM_SCRIPT_HEX_CHARS),
    valueDuffs: parseAmount(
      value.amount,
      hasSatoshis ? value.satoshis : undefined,
      `Dash UTXO ${index}`
    ),
    confirmations: parseSafeInteger(
      value.confirmations,
      `Dash UTXO ${index} confirmations`,
      MAXIMUM_BLOCK_HEIGHT
    ),
    ...(value.height === undefined
      ? {}
      : {
          height: parseSafeInteger(value.height, `Dash UTXO ${index} height`, MAXIMUM_BLOCK_HEIGHT)
        }),
    ...(value.ts === undefined
      ? {}
      : { timestamp: parseSafeInteger(value.ts, `Dash UTXO ${index} timestamp`) })
  }
  return Object.freeze(parsed)
}

export function parseDashUtxos(
  value: unknown,
  allowedAddresses: readonly string[]
): readonly DashUtxo[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_VECTOR) throw invalid('Dash UTXO response')
  const allowed = new Set(allowedAddresses)
  return Object.freeze(value.map((item, index) => parseUtxo(item, index, allowed)))
}

function parseScript(
  value: unknown,
  label: string
): { readonly hex: string; readonly addresses: readonly string[] } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['hex'], ['asm', 'addresses', 'type']) ||
    (value.asm !== undefined &&
      (typeof value.asm !== 'string' || value.asm.length > MAXIMUM_SCRIPT_HEX_CHARS)) ||
    (value.type !== undefined && (typeof value.type !== 'string' || value.type.length > 32))
  ) {
    throw invalid(label)
  }
  let addresses: readonly string[] = []
  if (value.addresses !== undefined) {
    if (!Array.isArray(value.addresses) || value.addresses.length > 16) throw invalid(label)
    addresses = Object.freeze(
      value.addresses.map((address, index) => parseText(address, `${label} address ${index}`, 128))
    )
  }
  return Object.freeze({
    hex: parseHex(value.hex, label, MAXIMUM_SCRIPT_HEX_CHARS),
    addresses
  })
}

function parseInput(value: unknown, index: number): DashTransactionInput {
  if (!isRecord(value)) throw invalid(`Dash input ${index}`)
  if (Object.prototype.hasOwnProperty.call(value, 'coinbase')) {
    if (!hasExactKeys(value, ['coinbase', 'sequence', 'n'])) throw invalid(`Dash input ${index}`)
    const inputIndex = parseUint32(value.n, `Dash input ${index} index`)
    if (inputIndex !== index) throw invalid(`Dash input ${index} index`)
    return Object.freeze({
      sequence: parseUint32(value.sequence, `Dash input ${index} sequence`),
      index: inputIndex,
      coinbase: parseHex(value.coinbase, `Dash input ${index} coinbase`, MAXIMUM_SCRIPT_HEX_CHARS)
    })
  }
  if (
    !hasExactKeys(
      value,
      ['txid', 'vout', 'sequence', 'n', 'valueSat'],
      ['scriptSig', 'addr', 'value', 'doubleSpentTxID']
    )
  ) {
    throw invalid(`Dash input ${index}`)
  }
  const inputIndex = parseUint32(value.n, `Dash input ${index} index`)
  if (inputIndex !== index) throw invalid(`Dash input ${index} index`)
  if (
    value.value !== undefined &&
    typeof value.value === 'number' &&
    !Number.isFinite(value.value)
  ) {
    throw invalid(`Dash input ${index} value`)
  }
  if (
    value.doubleSpentTxID !== undefined &&
    value.doubleSpentTxID !== null &&
    (typeof value.doubleSpentTxID !== 'string' || !TXID.test(value.doubleSpentTxID))
  ) {
    throw invalid(`Dash input ${index} double spend`)
  }
  if (value.scriptSig !== undefined) parseScript(value.scriptSig, `Dash input ${index} script`)
  return Object.freeze({
    previousTransactionId: parseHash(value.txid, `Dash input ${index} transaction ID`),
    outputIndex: parseUint32(value.vout, `Dash input ${index} output index`),
    sequence: parseUint32(value.sequence, `Dash input ${index} sequence`),
    index: inputIndex,
    valueDuffs: parseIntegerDuffs(value.valueSat, `Dash input ${index} value`),
    ...(typeof value.addr === 'string'
      ? { address: parseText(value.addr, `Dash input ${index} address`, 128) }
      : {})
  })
}

function parseNullableHash(value: unknown, label: string): string | null {
  if (value === null) return null
  return parseHash(value, label)
}

function parseNullableUint32(value: unknown, label: string): number | null {
  if (value === null) return null
  return parseUint32(value, label)
}

function parseOutput(value: unknown, index: number): DashTransactionOutput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['value', 'n', 'scriptPubKey', 'spentTxId', 'spentIndex', 'spentHeight'])
  ) {
    throw invalid(`Dash output ${index}`)
  }
  const outputIndex = parseUint32(value.n, `Dash output ${index} index`)
  if (outputIndex !== index) throw invalid(`Dash output ${index} index`)
  const script = parseScript(value.scriptPubKey, `Dash output ${index} script`)
  const spentHeight =
    value.spentHeight === null
      ? null
      : parseSafeInteger(
          value.spentHeight,
          `Dash output ${index} spent height`,
          MAXIMUM_BLOCK_HEIGHT
        )
  return Object.freeze({
    index: outputIndex,
    valueDuffs: parseDecimalDuffs(value.value, `Dash output ${index} value`),
    scriptHex: script.hex,
    addresses: script.addresses,
    spentTransactionId: parseNullableHash(
      value.spentTxId,
      `Dash output ${index} spent transaction`
    ),
    spentIndex: parseNullableUint32(value.spentIndex, `Dash output ${index} spent index`),
    spentHeight
  })
}

export function parseDashTransaction(value: unknown): DashTransaction {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'txid',
        'version',
        'locktime',
        'vin',
        'vout',
        'blockhash',
        'blockheight',
        'confirmations',
        'time',
        'valueOut',
        'size',
        'txlock'
      ],
      [
        'type',
        'extraPayloadSize',
        'extraPayload',
        'blocktime',
        'isCoinBase',
        'valueIn',
        'fees',
        'proRegTx',
        'proUpServTx',
        'proUpRegTx',
        'proUpRevTx',
        'cbTx',
        'qcTx',
        'mnhfTx'
      ]
    )
  ) {
    throw invalid('Dash transaction')
  }
  if (!Array.isArray(value.vin) || !Array.isArray(value.vout)) throw invalid('Dash transaction')
  if (value.vin.length > MAXIMUM_VECTOR || value.vout.length > MAXIMUM_VECTOR) {
    throw invalid('Dash transaction')
  }
  if (typeof value.valueOut !== 'number' || !Number.isFinite(value.valueOut)) {
    throw invalid('Dash transaction value')
  }
  if (
    value.valueIn !== undefined &&
    (typeof value.valueIn !== 'number' || !Number.isFinite(value.valueIn))
  ) {
    throw invalid('Dash transaction value')
  }
  if (
    value.fees !== undefined &&
    (typeof value.fees !== 'number' || !Number.isFinite(value.fees))
  ) {
    throw invalid('Dash transaction fee')
  }
  if (typeof value.txlock !== 'boolean') throw invalid('Dash transaction lock')
  if (value.isCoinBase !== undefined && typeof value.isCoinBase !== 'boolean') {
    throw invalid('Dash coinbase flag')
  }
  const type = value.type === undefined ? 0 : parseUint32(value.type, 'Dash transaction type')
  if (value.extraPayload !== undefined) {
    parseHex(value.extraPayload, 'Dash extra payload', MAXIMUM_SCRIPT_HEX_CHARS)
  }
  if (value.extraPayloadSize !== undefined) {
    parseSafeInteger(
      value.extraPayloadSize,
      'Dash extra payload size',
      MAXIMUM_SCRIPT_HEX_CHARS / 2
    )
  }
  for (const key of [
    'proRegTx',
    'proUpServTx',
    'proUpRegTx',
    'proUpRevTx',
    'cbTx',
    'qcTx',
    'mnhfTx'
  ]) {
    if (value[key] !== undefined && !isRecord(value[key])) throw invalid(`Dash ${key}`)
  }
  const confirmations = parseSafeInteger(
    value.confirmations,
    'Dash transaction confirmations',
    MAXIMUM_BLOCK_HEIGHT
  )
  const blockHeightNumber = value.blockheight
  if (!Number.isSafeInteger(blockHeightNumber) || (blockHeightNumber as number) < -1) {
    throw invalid('Dash transaction block height')
  }
  const confirmed = confirmations > 0
  if (confirmed && (blockHeightNumber as number) < 0) throw invalid('Dash transaction block height')
  if (!confirmed && value.blocktime !== undefined) throw invalid('Dash transaction block time')
  const inputs = Object.freeze(value.vin.map((item, index) => parseInput(item, index)))
  const outputs = Object.freeze(value.vout.map((item, index) => parseOutput(item, index)))
  const valueOut = outputs.reduce((sum, output) => sum + BigInt(output.valueDuffs), 0n)
  const isCoinbase = value.isCoinBase === true || inputs.some(input => input.coinbase !== undefined)
  let feeDuffs: string | undefined
  if (!isCoinbase && inputs.every(input => input.valueDuffs !== undefined)) {
    const valueIn = inputs.reduce((sum, input) => sum + BigInt(input.valueDuffs ?? '0'), 0n)
    if (valueIn < valueOut) throw invalid('Dash transaction fee')
    feeDuffs = (valueIn - valueOut).toString()
  }
  return Object.freeze({
    transactionId: parseHash(value.txid, 'Dash transaction ID'),
    version: parseUint32(value.version, 'Dash transaction version'),
    type,
    locktime: parseUint32(value.locktime, 'Dash transaction locktime'),
    sizeBytes: parseSafeInteger(value.size, 'Dash transaction size', 1_000_000),
    confirmations,
    blockHash:
      value.blockhash === null ? null : parseHash(value.blockhash, 'Dash transaction block hash'),
    blockHeight: (blockHeightNumber as number) < 0 ? null : (blockHeightNumber as number),
    time: parseSafeInteger(value.time, 'Dash transaction time'),
    ...(value.blocktime === undefined
      ? {}
      : { blockTime: parseSafeInteger(value.blocktime, 'Dash transaction block time') }),
    txlock: value.txlock,
    isCoinbase,
    inputs,
    outputs,
    valueOutDuffs: duffsToString(valueOut, 'Dash transaction value'),
    ...(feeDuffs === undefined ? {} : { feeDuffs })
  })
}

export function parseDashAddressTransactions(value: unknown): DashAddressTransactionPage {
  if (!isRecord(value) || !hasExactKeys(value, ['pagesTotal', 'txs'])) {
    throw invalid('Dash address transactions')
  }
  if (!Array.isArray(value.txs) || value.txs.length > DASH_INSIGHT_TX_PAGE_LENGTH) {
    throw invalid('Dash address transactions')
  }
  const pagesTotal = parseSafeInteger(value.pagesTotal, 'Dash transaction page count', 1_000_000)
  if ((value.txs.length === 0 && pagesTotal < 0) || (value.txs.length > 0 && pagesTotal < 1)) {
    throw invalid('Dash transaction page count')
  }
  return Object.freeze({
    pagesTotal,
    transactions: Object.freeze(value.txs.map(item => parseDashTransaction(item)))
  })
}

export function parseDashRawTransaction(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ['rawtx'])) throw invalid('Dash raw transaction')
  return parseHex(value.rawtx, 'Dash raw transaction', MAXIMUM_RAW_TRANSACTION_HEX_CHARS)
}

export function parseDashBroadcastResult(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ['txid'])) throw invalid('Dash broadcast response')
  return parseHash(value.txid, 'Dash broadcast transaction ID')
}
