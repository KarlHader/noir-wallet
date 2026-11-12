import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { getQuantusNetworkConfigs } from '@/config/networks'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { parseChainId } from '@/core/chains/registry'
import { parseQuantusAddress } from '@/core/chains/quantus'

import {
  QuantusRpcError,
  type QuantusBroadcastRpc,
  type QuantusReadRpc,
  type QuantusRpcClientConfig
} from './quantus-rpc-types'
import { decodeQuantusAccountInfo, quantusSystemAccountStorageKey } from './quantus-account-storage'

export {
  QUANTUS_RPC_ERROR_CODES,
  QuantusRpcError,
  type QuantusAccountInfo,
  type QuantusBlock,
  type QuantusBroadcastRpc,
  type QuantusMetadata,
  type QuantusReadRpc,
  type QuantusRpcClientConfig,
  type QuantusRpcErrorCode,
  type QuantusRuntimeVersion
} from './quantus-rpc-types'

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
const MAXIMUM_EXTRINSIC_HEX_CHARS = 4 * 1024 * 1024
const HEX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const HEX_DATA_PATTERN = /^0x([0-9a-fA-F]{2})+$/
const HEX_STORAGE_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/
const MAXIMUM_EXTRINSICS_PER_BLOCK = 4_096
const MAXIMUM_EVENTS_HEX_CHARS = 2 * MAXIMUM_RESPONSE_BYTES
const MAXIMUM_METADATA_HEX_CHARS = 2 * MAXIMUM_RESPONSE_BYTES
const METADATA_MAGIC = '0x6d657461'
const MAXIMUM_U128 = (1n << 128n) - 1n
// twox128("System") ++ twox128("Events")
const SYSTEM_EVENTS_STORAGE_KEY =
  '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7'

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
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false
  }
  return true
}

function parseRpcUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Quantus RPC URL')
  }
  const localDevelopmentHost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopmentHost)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Quantus RPC URL must be a credential-free HTTPS endpoint')
  }
  return url.toString()
}

function parseExpectedNetwork(chainIdValue: string) {
  const chainId = parseChainId(chainIdValue)
  if (chainId.namespace !== 'quantus') throw new Error('Invalid Quantus chain ID')
  const network = getQuantusNetworkConfigs().find(candidate => candidate.chainId === chainId.id)
  if (!network) throw new Error('Unsupported Quantus chain ID')
  return network
}

function readHexHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX_HASH_PATTERN.test(value)) {
    throw new QuantusRpcError('invalid-response', `${label} must be a 32-byte hex hash`)
  }
  return value.toLowerCase()
}

function readExtrinsicHex(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > MAXIMUM_EXTRINSIC_HEX_CHARS ||
    value.length % 2 !== 0 ||
    !HEX_DATA_PATTERN.test(value)
  ) {
    throw new Error('Invalid Quantus extrinsic')
  }
  return value.toLowerCase()
}

function readExtrinsicList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_EXTRINSICS_PER_BLOCK) {
    throw new QuantusRpcError('invalid-response', `${label} must be a bounded extrinsic list`)
  }
  return Object.freeze(
    value.map((item: unknown) => {
      if (
        typeof item !== 'string' ||
        item.length < 4 ||
        item.length > MAXIMUM_EXTRINSIC_HEX_CHARS ||
        !HEX_DATA_PATTERN.test(item)
      ) {
        throw new QuantusRpcError('invalid-response', `${label} contains an invalid extrinsic`)
      }
      return item.toLowerCase()
    })
  )
}

function readMetadata(value: unknown): Readonly<{ hex: string; version: number }> {
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_METADATA_HEX_CHARS ||
    value.length < METADATA_MAGIC.length + 4 ||
    !HEX_DATA_PATTERN.test(value) ||
    !value.toLowerCase().startsWith(METADATA_MAGIC)
  ) {
    throw new QuantusRpcError('invalid-response', 'Quantus runtime metadata is invalid')
  }
  const hex = value.toLowerCase()
  const version = Number.parseInt(hex.slice(METADATA_MAGIC.length, METADATA_MAGIC.length + 2), 16)
  if (version !== 14 && version !== 15) {
    throw new QuantusRpcError('invalid-response', 'Quantus runtime metadata version is unsupported')
  }
  return Object.freeze({ hex, version })
}

function readFee(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.partialFee !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.partialFee) ||
    value.partialFee.length > 39 ||
    BigInt(value.partialFee) > MAXIMUM_U128
  ) {
    throw new QuantusRpcError(
      'invalid-response',
      'Quantus payment_queryInfo partial fee is invalid'
    )
  }
  return value.partialFee
}

function readEventsStorage(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_EVENTS_HEX_CHARS ||
    !HEX_STORAGE_PATTERN.test(value)
  ) {
    throw new QuantusRpcError('invalid-response', 'Quantus events storage is invalid')
  }
  return value.toLowerCase()
}
function readSafeUnsignedInteger(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new QuantusRpcError('invalid-response', `${label} must be a safe unsigned integer`)
    }
    return value
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      throw new QuantusRpcError('invalid-response', `${label} must be a safe unsigned integer`)
    }
    return parsed
  }
  throw new QuantusRpcError('invalid-response', `${label} must be a safe unsigned integer`)
}

function parseRpcError(value: unknown): QuantusRpcError {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'message'], ['data', 'name']) ||
    !Number.isSafeInteger(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 4_096
  ) {
    return new QuantusRpcError('invalid-response', 'Invalid Quantus RPC error response')
  }
  if (value.code === 429 || value.code === -32_005) {
    return new QuantusRpcError('rate-limited', 'Quantus RPC rate limit exceeded')
  }
  // Nodes may include transaction bytes or account details in arbitrary errors.
  // Only expose recognized validity categories, never the raw RPC message/data.
  const message =
    `${value.message} ${typeof value.data === 'string' && value.data.length <= 4096 ? value.data : ''}`.toLowerCase()
  if (/\b(stale|outdated)\b/.test(message)) {
    return new QuantusRpcError('rpc-error', 'Quantus rejected the extrinsic: nonce is stale')
  }
  if (/\b(future|nonce too high)\b/.test(message)) {
    return new QuantusRpcError(
      'rpc-error',
      'Quantus rejected the extrinsic: nonce is in the future'
    )
  }
  if (/\b(bad signature|bad proof|badproof|invalid signature)\b/.test(message)) {
    return new QuantusRpcError('bad-signature', 'Quantus rejected the extrinsic: invalid signature')
  }
  if (/\b(ancient birth block|expired|mortal era)\b/.test(message)) {
    return new QuantusRpcError('rpc-error', 'Quantus rejected the extrinsic: signing era expired')
  }
  if (/\b(payment|insufficient balance|insufficient funds)\b/.test(message)) {
    return new QuantusRpcError(
      'rpc-error',
      'Quantus rejected the extrinsic: insufficient funds for fees'
    )
  }
  if (/\b(call|invalid call|invalidtransaction::call)\b/.test(message)) {
    return new QuantusRpcError(
      'rpc-error',
      'Quantus rejected the extrinsic: invalid transaction call'
    )
  }
  if (value.code === 1010 || value.code === 1011) {
    return new QuantusRpcError('rpc-error', 'Quantus rejected the extrinsic as invalid')
  }
  return new QuantusRpcError('rpc-error', 'Quantus RPC request failed')
}

function mapHttpError(status: number): QuantusRpcError {
  if (status === 401 || status === 403) {
    return new QuantusRpcError('unauthorized', 'Quantus RPC authorization failed')
  }
  if (status === 429) return new QuantusRpcError('rate-limited', 'Quantus RPC rate limit exceeded')
  return new QuantusRpcError('network-unavailable', 'Quantus RPC endpoint is unavailable')
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new QuantusRpcError('invalid-response', 'Quantus RPC response exceeds the allowed size')
  )
}

export function createQuantusRpcClient(
  config: QuantusRpcClientConfig,
  fetchImplementation: FetchImplementation = fetch
): QuantusReadRpc & QuantusBroadcastRpc {
  const expectedNetwork = parseExpectedNetwork(config.chainId)
  const rpcUrl = parseRpcUrl(config.rpcUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid Quantus RPC timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid Quantus RPC response limit')
  }

  let requestId = 0
  const request = async (
    method:
      | 'chain_getBlockHash'
      | 'chain_getFinalizedHead'
      | 'chain_getHeader'
      | 'chain_getBlock'
      | 'payment_queryInfo'
      | 'author_pendingExtrinsics'
      | 'state_getRuntimeVersion'
      | 'state_getMetadata'
      | 'state_getStorage'
      | 'system_accountNextIndex'
      | 'system_chain'
      | 'author_submitExtrinsic',
    params: readonly unknown[],
    externalSignal?: AbortSignal
  ): Promise<unknown> => {
    if (externalSignal?.aborted) {
      throw new QuantusRpcError('cancelled', 'Quantus RPC request was cancelled')
    }
    const controller = new AbortController()
    let timedOut = false
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    requestId = requestId >= 2_147_483_647 ? 1 : requestId + 1
    const id = requestId
    try {
      const response = await fetchImplementation(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      })
      if (!response.ok) throw mapHttpError(response.status)
      const text = await readResponseText(response, maximumResponseBytes)
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new QuantusRpcError('invalid-response', 'Quantus RPC response is not JSON')
      }
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ['jsonrpc', 'id'], ['result', 'error']) ||
        payload.jsonrpc !== '2.0' ||
        payload.id !== id
      ) {
        throw new QuantusRpcError('invalid-response', 'Quantus RPC response shape is invalid')
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
        if (Object.prototype.hasOwnProperty.call(payload, 'result')) {
          throw new QuantusRpcError(
            'invalid-response',
            'Quantus RPC response has both result and error'
          )
        }
        throw parseRpcError(payload.error)
      }
      if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
        throw new QuantusRpcError('invalid-response', 'Quantus RPC response is missing a result')
      }
      return payload.result
    } catch (error) {
      if (error instanceof QuantusRpcError) throw error
      if (controller.signal.aborted) {
        throw new QuantusRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'Quantus RPC request timed out' : 'Quantus RPC request was cancelled'
        )
      }
      throw new QuantusRpcError('network-unavailable', 'Quantus RPC request failed')
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) => {
      const genesisHash = readHexHash(
        await request('chain_getBlockHash', [0], signal),
        'Quantus genesis hash'
      )
      if (genesisHash !== expectedNetwork.genesisHash.toLowerCase()) {
        throw new QuantusRpcError('chain-mismatch', 'Quantus RPC endpoint returned the wrong chain')
      }
      const chainName = await request('system_chain', [], signal)
      if (
        typeof chainName !== 'string' ||
        chainName.trim() !== chainName ||
        chainName.length === 0
      ) {
        throw new QuantusRpcError('invalid-response', 'Quantus system_chain response is invalid')
      }
      const expectedName = expectedNetwork.networkName === 'mainnet' ? 'Quantus' : 'Planck'
      if (chainName !== expectedName) {
        throw new QuantusRpcError('chain-mismatch', 'Quantus RPC endpoint returned the wrong chain')
      }
    },
    getGenesisHash: async (signal?: AbortSignal) =>
      readHexHash(await request('chain_getBlockHash', [0], signal), 'Quantus genesis hash'),
    getBestHead: async (signal?: AbortSignal) =>
      readHexHash(await request('chain_getBlockHash', [], signal), 'Quantus best head'),
    getFinalizedHead: async (signal?: AbortSignal) =>
      readHexHash(await request('chain_getFinalizedHead', [], signal), 'Quantus finalized head'),
    getBlockHash: async (number: number, signal?: AbortSignal) => {
      if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error('Invalid Quantus block number')
      }
      return readHexHash(
        await request('chain_getBlockHash', [number], signal),
        'Quantus block hash'
      )
    },
    getBlock: async (hash: string, signal?: AbortSignal) => {
      const blockHash = readHexHash(hash, 'Quantus block hash')
      const result = await request('chain_getBlock', [blockHash], signal)
      if (
        !isRecord(result) ||
        !hasExactKeys(result, ['block'], ['justifications']) ||
        !isRecord(result.block) ||
        !hasExactKeys(result.block, ['header', 'extrinsics']) ||
        !isRecord(result.block.header) ||
        !hasExactKeys(result.block.header, [
          'parentHash',
          'number',
          'stateRoot',
          'extrinsicsRoot',
          'digest'
        ]) ||
        typeof result.block.header.parentHash !== 'string' ||
        !HEX_HASH_PATTERN.test(result.block.header.parentHash) ||
        typeof result.block.header.stateRoot !== 'string' ||
        !HEX_HASH_PATTERN.test(result.block.header.stateRoot) ||
        typeof result.block.header.extrinsicsRoot !== 'string' ||
        !HEX_HASH_PATTERN.test(result.block.header.extrinsicsRoot) ||
        !isRecord(result.block.header.digest) ||
        !hasExactKeys(result.block.header.digest, ['logs']) ||
        !Array.isArray(result.block.header.digest.logs) ||
        result.block.header.digest.logs.length > MAXIMUM_EXTRINSICS_PER_BLOCK ||
        result.block.header.digest.logs.some(
          log => typeof log !== 'string' || !HEX_STORAGE_PATTERN.test(log)
        ) ||
        typeof result.block.header.number !== 'string' ||
        !/^0x[0-9a-fA-F]+$/.test(result.block.header.number) ||
        !Number.isSafeInteger(Number.parseInt(result.block.header.number, 16))
      ) {
        throw new QuantusRpcError('invalid-response', 'Quantus block response is invalid')
      }
      return Object.freeze({
        extrinsics: readExtrinsicList(result.block.extrinsics, 'Quantus block')
      })
    },
    getPendingExtrinsics: async (signal?: AbortSignal) =>
      readExtrinsicList(
        await request('author_pendingExtrinsics', [], signal),
        'Quantus pending pool'
      ),
    getEventsStorage: async (blockHash: string, signal?: AbortSignal) =>
      readEventsStorage(
        await request(
          'state_getStorage',
          [SYSTEM_EVENTS_STORAGE_KEY, readHexHash(blockHash, 'Quantus block hash')],
          signal
        )
      ),
    queryFee: async (signedExtrinsicHex: string, signal?: AbortSignal) =>
      readFee(await request('payment_queryInfo', [readExtrinsicHex(signedExtrinsicHex)], signal)),
    getHeader: async (hash?: string, signal?: AbortSignal) => {
      const params =
        hash === undefined
          ? Object.freeze([])
          : Object.freeze([readHexHash(hash, 'Quantus block hash')])
      const header = await request('chain_getHeader', params, signal)
      if (
        !isRecord(header) ||
        typeof header.parentHash !== 'string' ||
        typeof header.number !== 'string'
      ) {
        throw new QuantusRpcError('invalid-response', 'Quantus header response is invalid')
      }
      if (!/^0x[0-9a-fA-F]+$/.test(header.number)) {
        throw new QuantusRpcError('invalid-response', 'Quantus header number is invalid')
      }
      const number = Number.parseInt(header.number, 16)
      if (!Number.isSafeInteger(number) || number < 0) {
        throw new QuantusRpcError('invalid-response', 'Quantus header number is invalid')
      }
      return Object.freeze({
        parentHash: readHexHash(header.parentHash, 'Quantus header parent hash'),
        number
      })
    },
    getAccountInfo: async (addressValue: string, signal?: AbortSignal) => {
      const storageKey = quantusSystemAccountStorageKey(addressValue)
      return decodeQuantusAccountInfo(await request('state_getStorage', [storageKey], signal))
    },
    getSystemAccountNextIndex: async (addressValue: string, signal?: AbortSignal) => {
      const address = parseQuantusAddress(addressValue)
      const index = await request('system_accountNextIndex', [address], signal)
      return readSafeUnsignedInteger(index, 'Quantus account next index')
    },
    getRuntimeVersion: async (signal?: AbortSignal) => {
      const version = await request('state_getRuntimeVersion', [], signal)
      if (!isRecord(version)) {
        throw new QuantusRpcError('invalid-response', 'Quantus runtime version is invalid')
      }
      return Object.freeze({
        specVersion: readSafeUnsignedInteger(version.specVersion, 'Quantus spec version'),
        transactionVersion: readSafeUnsignedInteger(
          version.transactionVersion,
          'Quantus transaction version'
        )
      })
    },
    getMetadata: async (signal?: AbortSignal) => {
      const metadata = await request('state_getMetadata', [], signal)
      return readMetadata(metadata)
    },
    submitExtrinsic: async (extrinsicValue: string, signal?: AbortSignal) => {
      const extrinsic = readExtrinsicHex(extrinsicValue)
      return readHexHash(
        await request('author_submitExtrinsic', [extrinsic], signal),
        'Quantus extrinsic hash'
      )
    }
  })
}
