import type { AssetDisplayMetadata } from '@/core/chains/domain'
import { EvmRpcError, type EvmContractRpc } from './evm-rpc-client'

const NAME_SELECTOR = '0x06fdde03'
const SYMBOL_SELECTOR = '0x95d89b41'
const DECIMALS_SELECTOR = '0x313ce567'
const WORD_BYTES = 32
const MAXIMUM_METADATA_BYTES = 512

function invalidMetadata(label: string): EvmRpcError {
  return new EvmRpcError('invalid-response', `Invalid ERC-20 ${label} response`)
}

function decodeHex(value: string, label: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) throw invalidMetadata(label)
  const result = new Uint8Array((value.length - 2) / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16)
  }
  return result
}

function decodeWord(bytes: Uint8Array, offset: number, label: string): number {
  if (offset < 0 || offset + WORD_BYTES > bytes.length) throw invalidMetadata(label)
  let value = 0n
  for (let index = offset; index < offset + WORD_BYTES; index += 1) {
    value = (value << 8n) | BigInt(bytes[index])
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidMetadata(label)
  return Number(value)
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalidMetadata(label)
  }
  if (value.length === 0 || value.includes('\u0000')) throw invalidMetadata(label)
  return value
}

function decodeDynamicString(bytes: Uint8Array, label: string): string {
  if (bytes.length < WORD_BYTES * 2 || bytes.length % WORD_BYTES !== 0) {
    throw invalidMetadata(label)
  }
  const offset = decodeWord(bytes, 0, label)
  if (offset < WORD_BYTES || offset % WORD_BYTES !== 0) throw invalidMetadata(label)
  const length = decodeWord(bytes, offset, label)
  if (length === 0 || length > MAXIMUM_METADATA_BYTES) throw invalidMetadata(label)
  const start = offset + WORD_BYTES
  const paddedEnd = start + Math.ceil(length / WORD_BYTES) * WORD_BYTES
  if (paddedEnd !== bytes.length) throw invalidMetadata(label)
  if (bytes.slice(start + length, paddedEnd).some(byte => byte !== 0)) {
    throw invalidMetadata(label)
  }
  return decodeUtf8(bytes.slice(start, start + length), label)
}

function decodeLegacyBytes32(bytes: Uint8Array, label: string): string {
  if (bytes.length !== WORD_BYTES) throw invalidMetadata(label)
  const terminator = bytes.indexOf(0)
  const length = terminator === -1 ? bytes.length : terminator
  if (length === 0 || bytes.slice(length).some(byte => byte !== 0)) throw invalidMetadata(label)
  return decodeUtf8(bytes.slice(0, length), label)
}

function decodeStringResult(value: string, label: string): string {
  const bytes = decodeHex(value, label)
  try {
    return decodeDynamicString(bytes, label)
  } catch (error) {
    if (bytes.length !== WORD_BYTES) throw error
    return decodeLegacyBytes32(bytes, label)
  }
}

function decodeDecimals(value: string): number {
  const bytes = decodeHex(value, 'decimals')
  const decimals = decodeWord(bytes, 0, 'decimals')
  if (bytes.length !== WORD_BYTES || decimals > 255) throw invalidMetadata('decimals')
  return decimals
}

export async function readErc20Metadata(
  rpc: EvmContractRpc,
  contractAddress: string,
  signal?: AbortSignal
): Promise<AssetDisplayMetadata> {
  await rpc.assertExpectedChain(signal)
  const code = await rpc.getCode(contractAddress, signal)
  if (code === '0x' || /^0x0+$/.test(code)) {
    throw new Error('The address does not contain an ERC-20 contract')
  }
  const [name, symbol, decimals] = await Promise.all([
    rpc
      .callContract(contractAddress, NAME_SELECTOR, signal)
      .then(value => decodeStringResult(value, 'name')),
    rpc
      .callContract(contractAddress, SYMBOL_SELECTOR, signal)
      .then(value => decodeStringResult(value, 'symbol')),
    rpc.callContract(contractAddress, DECIMALS_SELECTOR, signal).then(decodeDecimals)
  ])
  return Object.freeze({ name, symbol, decimals })
}
