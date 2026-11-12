import { ledgerStarknetDerivationPath } from '@/core/wallet/ledger-derivation-path'

// Starknet Ledger app v2.4.3. CLA 0x5A.
// GetPubKey returns a 65-byte ECPublicKey. The Stark key is x at bytes [1..33].
// poseidon_shift is not a mismatch. The app left-shifts a 252-bit hash by 4 and
// the C SDK shifts it back before ECDSA. Do not shift before attach. Verify
// the device hash against the raw transaction hash.

export const LEDGER_STARKNET_APP_NAME = 'Starknet'
export const LEDGER_STARKNET_APP_VERSION = '2.4.3'
export const LEDGER_STARKNET_CLA = 0x5a
export const LEDGER_STARKNET_GET_VERSION = 0x00
export const LEDGER_STARKNET_GET_PUBKEY = 0x01
export const LEDGER_STARKNET_SIGN_HASH = 0x02
export const LEDGER_STARKNET_INVOKE_V3 = 0x03
export const LEDGER_STARKNET_DEPLOY_ACCOUNT_V3 = 0x05
export const LEDGER_STARKNET_MAX_CALLS = 8
export const LEDGER_STARKNET_HASH_TRUNCATION_BITS = 252
export const LEDGER_STARKNET_SUPPORTED_MODELS = Object.freeze(['nanoX', 'nanoSP'] as const)

export const ARGENT_V04_CLASS_HASH =
  '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'
export const ARGENT_V05_CLASS_HASH =
  '0x073414441639dcd11d1846f287650a00c60c416b9d3ba45d31c651672125b2c2'
export const STARKNET_TRANSFER_SELECTOR =
  '0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e'
export const STARKNET_CLEAR_SIGN_TOKENS = Object.freeze([
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8'
] as const)

const FELT_LIMIT = 1n << 251n
const U64_LIMIT = 1n << 64n
const U128_LIMIT = 1n << 128n

export interface StarknetApdu {
  readonly cla: number
  readonly ins: number
  readonly p1: number
  readonly p2: number
  readonly data: Uint8Array
}

export interface StarknetFeeWords {
  readonly tip: bigint
  readonly l1Gas: { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint }
  readonly l2Gas: { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint }
  readonly l1DataGas: { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint }
}

export interface StarknetLedgerCall {
  readonly to: string
  readonly selector: string
  readonly calldata: readonly string[]
}

export function assertLedgerStarknetDeviceSupported(deviceModel: string): void {
  if (
    !LEDGER_STARKNET_SUPPORTED_MODELS.includes(
      deviceModel as (typeof LEDGER_STARKNET_SUPPORTED_MODELS)[number]
    )
  ) {
    throw new Error(
      deviceModel === 'nanoS'
        ? 'Ledger Nano S cannot run the Starknet app'
        : 'Starknet Ledger supports Nano X and Nano S Plus in this phase'
    )
  }
}

export { ledgerStarknetDerivationPath }

export function ledgerStarknetPathBytes(path: string): Uint8Array {
  const parts = path.split('/')
  if (
    parts.length !== 7 ||
    parts[0] !== 'm' ||
    parts[1] !== "2645'" ||
    parts[2] !== "1195502025'" ||
    parts[3] !== "1148870696'" ||
    parts[4] !== "0'" ||
    parts[5] !== "0'" ||
    !/^(?:0|[1-9][0-9]*)$/.test(parts[6])
  ) {
    throw new Error('Invalid Ledger Starknet derivation path')
  }
  const index = Number(parts[6])
  if (!Number.isSafeInteger(index) || index > 0x7fffffff) {
    throw new Error('Invalid Ledger Starknet derivation path')
  }
  const words = [0x80000a55, 0xc741e9c9, 0xc47a6028, 0x80000000, 0x80000000, index]
  const bytes = new Uint8Array(24)
  words.forEach((word, offset) => {
    bytes[offset * 4] = (word >>> 24) & 0xff
    bytes[offset * 4 + 1] = (word >>> 16) & 0xff
    bytes[offset * 4 + 2] = (word >>> 8) & 0xff
    bytes[offset * 4 + 3] = word & 0xff
  })
  return bytes
}

export function starknetFeltBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error('Invalid Starknet felt')
  }
  const hex = value.slice(2).padStart(64, '0')
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  if (feltToBigint(bytes) >= FELT_LIMIT) throw new Error('Starknet felt is out of range')
  return bytes
}

export function starknetFeltHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('Invalid Starknet felt')
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const stripped = hex.replace(/^0+/, '')
  return `0x${stripped === '' ? '0' : stripped}`
}

export function starknetLedgerPublicKey(response: Uint8Array): string {
  if (response.length !== 65) throw new Error('Ledger Starknet public key must be 65 bytes')
  return starknetFeltHex(response.subarray(1, 33))
}

export function parseStarknetLedgerSignature(
  response: Uint8Array,
  expectedHash?: Uint8Array
): { readonly r: string; readonly s: string } {
  const prefix = expectedHash ? 32 : 0
  const length = prefix + 1 + 32 + 32 + 1
  if (response.length !== length || response[prefix] !== 0x41) {
    throw new Error('Ledger Starknet signature frame is invalid')
  }
  if (expectedHash && !bytesEqual(response.subarray(0, 32), expectedHash)) {
    throw new Error('Ledger Starknet hash does not match the raw transaction hash')
  }
  return {
    r: starknetFeltHex(response.subarray(prefix + 1, prefix + 33)),
    s: starknetFeltHex(response.subarray(prefix + 33, prefix + 65))
  }
}

export function starknetStatusError(status: number): Error | null {
  if (status === 0x9000) return null
  if (status === 0x6985 || status === 0x6e04)
    return new Error('Ledger Starknet request was rejected')
  if (status === 0x6e00 || status === 0x6e01 || status === 0x6e02 || status === 0x6e03) {
    return new Error(`Ledger Starknet app rejected the request (0x${status.toString(16)})`)
  }
  if (status === 0xff02) return new Error('Ledger Starknet clear-sign payload is malformed')
  if (status === 0xff05) return new Error('Ledger Starknet deploy address does not match')
  return new Error(`Ledger Starknet app rejected the request (0x${status.toString(16)})`)
}

export function planStarknetGetVersionApdu(): StarknetApdu {
  return apdu(LEDGER_STARKNET_GET_VERSION, 0, 0, new Uint8Array())
}

export function planStarknetGetPubKeyApdu(path: string, confirm: boolean): StarknetApdu {
  return apdu(LEDGER_STARKNET_GET_PUBKEY, confirm ? 1 : 0, 0, ledgerStarknetPathBytes(path))
}

export function planStarknetSignHashApdus(
  path: string,
  messageHash: string
): readonly StarknetApdu[] {
  return [
    apdu(LEDGER_STARKNET_SIGN_HASH, 0, 0, ledgerStarknetPathBytes(path)),
    apdu(LEDGER_STARKNET_SIGN_HASH, 1, 0, starknetFeltBytes(messageHash))
  ]
}

export function planStarknetInvokeApdus(input: {
  readonly path: string
  readonly senderAddress: string
  readonly chainIdFelt: string
  readonly nonce: string
  readonly dataAvailabilityMode: string
  readonly fees: StarknetFeeWords
  readonly calls: readonly StarknetLedgerCall[]
}): readonly StarknetApdu[] {
  if (input.calls.length === 0 || input.calls.length > LEDGER_STARKNET_MAX_CALLS) {
    throw new Error('Invalid Ledger Starknet call count')
  }
  return [
    apdu(LEDGER_STARKNET_INVOKE_V3, 0, 0, ledgerStarknetPathBytes(input.path)),
    apdu(
      LEDGER_STARKNET_INVOKE_V3,
      1,
      0,
      concat(
        starknetFeltBytes(input.senderAddress),
        starknetFeltBytes(input.chainIdFelt),
        starknetFeltBytes(input.nonce),
        starknetFeltBytes(input.dataAvailabilityMode)
      )
    ),
    apdu(LEDGER_STARKNET_INVOKE_V3, 2, 0, feeBytes(input.fees)),
    apdu(LEDGER_STARKNET_INVOKE_V3, 3, 0, new Uint8Array()),
    apdu(LEDGER_STARKNET_INVOKE_V3, 4, 0, new Uint8Array()),
    apdu(
      LEDGER_STARKNET_INVOKE_V3,
      5,
      0,
      starknetFeltBytes(bigintFelt(BigInt(input.calls.length)))
    ),
    ...input.calls.flatMap(call => chunkCall(LEDGER_STARKNET_INVOKE_V3, callFelts(call)))
  ]
}

export function planStarknetDeployAccountApdus(input: {
  readonly path: string
  readonly contractAddress: string
  readonly chainIdFelt: string
  readonly nonce: string
  readonly dataAvailabilityMode: string
  readonly classHash: string
  readonly salt: string
  readonly fees: StarknetFeeWords
  readonly constructorCalldata: readonly string[]
}): readonly StarknetApdu[] {
  if (input.constructorCalldata.length > 8) {
    throw new Error('Invalid Ledger Starknet constructor count')
  }
  const constructor = input.constructorCalldata.map(starknetFeltBytes)
  return [
    apdu(LEDGER_STARKNET_DEPLOY_ACCOUNT_V3, 0, 0, ledgerStarknetPathBytes(input.path)),
    apdu(
      LEDGER_STARKNET_DEPLOY_ACCOUNT_V3,
      1,
      0,
      concat(
        starknetFeltBytes(input.contractAddress),
        starknetFeltBytes(input.chainIdFelt),
        starknetFeltBytes(input.nonce),
        starknetFeltBytes(input.dataAvailabilityMode),
        starknetFeltBytes(input.classHash),
        starknetFeltBytes(input.salt)
      )
    ),
    apdu(LEDGER_STARKNET_DEPLOY_ACCOUNT_V3, 2, 0, feeBytes(input.fees)),
    apdu(LEDGER_STARKNET_DEPLOY_ACCOUNT_V3, 3, 0, new Uint8Array()),
    apdu(
      LEDGER_STARKNET_DEPLOY_ACCOUNT_V3,
      4,
      0,
      starknetFeltBytes(bigintFelt(BigInt(constructor.length)))
    ),
    ...(constructor.length === 0
      ? [apdu(LEDGER_STARKNET_DEPLOY_ACCOUNT_V3, 5, 0, new Uint8Array())]
      : chunkFelts(LEDGER_STARKNET_DEPLOY_ACCOUNT_V3, 5, constructor))
  ]
}

export function encodeStarknetFeeWords(fees: StarknetFeeWords): Uint8Array {
  return feeBytes(fees)
}

export function starknetClassAllowed(classHash: string | null, computedClassHash: string): boolean {
  const computed = normalizeFelt(computedClassHash)
  if (computed !== normalizeFelt(ARGENT_V04_CLASS_HASH)) return false
  if (classHash === null) return true
  const onChain = normalizeFelt(classHash)
  return onChain === computed || onChain === normalizeFelt(ARGENT_V05_CLASS_HASH)
}

export function isClearSignedStarknetTransfer(
  calls: readonly {
    readonly contract?: string
    readonly selector?: string
    readonly entrypoint?: string
    readonly calldata: readonly string[]
  }[]
): boolean {
  if (calls.length !== 1) return false
  const call = calls[0]
  const contract = call.contract ? normalizeFelt(call.contract) : ''
  const selector = call.selector ? normalizeFelt(call.selector) : ''
  const namedTransfer = call.entrypoint === 'transfer'
  const selectorTransfer = selector === normalizeFelt(STARKNET_TRANSFER_SELECTOR)
  if (!STARKNET_CLEAR_SIGN_TOKENS.some(token => normalizeFelt(token) === contract)) return false
  if (!selectorTransfer && !namedTransfer) return false
  if (call.calldata.length !== 3) return false
  return normalizeFelt(call.calldata[2]) === '0x0'
}

export function normalizeStarknetLedgerFelt(value: string): string {
  return normalizeFelt(value)
}

function feeBytes(fees: StarknetFeeWords): Uint8Array {
  return concat(
    tipWord(fees.tip),
    resourceWord('\0\0L1_GAS', fees.l1Gas.maxAmount, fees.l1Gas.maxPricePerUnit),
    resourceWord('\0\0L2_GAS', fees.l2Gas.maxAmount, fees.l2Gas.maxPricePerUnit),
    resourceWord('\0L1_DATA', fees.l1DataGas.maxAmount, fees.l1DataGas.maxPricePerUnit)
  )
}

function tipWord(tip: bigint): Uint8Array {
  const word = new Uint8Array(32)
  word.set(unsigned(tip, 8, U64_LIMIT, 'tip'), 24)
  return word
}

function resourceWord(name: string, amount: bigint, price: bigint): Uint8Array {
  const word = new Uint8Array(32)
  const tag = new TextEncoder().encode(name)
  if (tag.length !== 8) throw new Error('Invalid Starknet fee resource')
  word.set(tag, 0)
  word.set(unsigned(amount, 8, U64_LIMIT, 'max amount'), 8)
  word.set(unsigned(price, 16, U128_LIMIT, 'max price'), 16)
  return word
}

function callFelts(call: StarknetLedgerCall): readonly Uint8Array[] {
  return [
    starknetFeltBytes(call.to),
    starknetFeltBytes(call.selector),
    starknetFeltBytes(bigintFelt(BigInt(call.calldata.length))),
    ...call.calldata.map(starknetFeltBytes)
  ]
}

function chunkCall(ins: number, felts: readonly Uint8Array[]): readonly StarknetApdu[] {
  if (felts.length < 3) throw new Error('Ledger Starknet call is too short')
  return chunkFelts(ins, 6, felts)
}

function chunkFelts(
  ins: number,
  p1: number,
  felts: readonly Uint8Array[]
): readonly StarknetApdu[] {
  const chunks: StarknetApdu[] = []
  for (let offset = 0; offset < felts.length; offset += 7) {
    const slice = felts.slice(offset, offset + 7)
    chunks.push(apdu(ins, p1, chunks.length === 0 ? 0 : 1, concat(...slice)))
  }
  return chunks
}

function apdu(ins: number, p1: number, p2: number, data: Uint8Array): StarknetApdu {
  return { cla: LEDGER_STARKNET_CLA, ins, p1, p2, data }
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function unsigned(value: bigint, width: number, limit: bigint, label: string): Uint8Array {
  if (value < 0n || value >= limit) throw new Error(`Starknet ${label} is out of range`)
  const bytes = new Uint8Array(width)
  let rest = value
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return bytes
}

function bigintFelt(value: bigint): string {
  return `0x${value.toString(16)}`
}

function feltToBigint(bytes: Uint8Array): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
}

function normalizeFelt(value: string): string {
  return starknetFeltHex(starknetFeltBytes(value))
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

export async function exchangeStarknetApdus(
  apdus: readonly StarknetApdu[],
  send: (apdu: StarknetApdu) => Promise<{ readonly data: Uint8Array; readonly status: number }>
): Promise<Uint8Array> {
  let last = new Uint8Array()
  for (const command of apdus) {
    const response = await send(command)
    const error = starknetStatusError(response.status)
    if (error) throw error
    last = Uint8Array.from(response.data)
  }
  return last
}

export async function readLedgerStarknetVersion(
  send: (apdu: StarknetApdu) => Promise<{ readonly data: Uint8Array; readonly status: number }>
): Promise<string> {
  const response = await exchangeStarknetApdus([planStarknetGetVersionApdu()], send)
  if (response.length !== 3) throw new Error('Ledger Starknet version is invalid')
  const version = `${response[0]}.${response[1]}.${response[2]}`
  if (version !== LEDGER_STARKNET_APP_VERSION) {
    throw new Error(`Starknet Ledger app ${LEDGER_STARKNET_APP_VERSION} is required`)
  }
  return version
}

export async function readLedgerStarknetPublicKey(
  path: string,
  confirm: boolean,
  send: (apdu: StarknetApdu) => Promise<{ readonly data: Uint8Array; readonly status: number }>
): Promise<string> {
  const response = await exchangeStarknetApdus([planStarknetGetPubKeyApdu(path, confirm)], send)
  return starknetLedgerPublicKey(response)
}
