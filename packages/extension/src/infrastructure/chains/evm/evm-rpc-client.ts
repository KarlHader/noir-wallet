import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { parseChainId } from '@/core/chains/registry'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import type { EvmDAppReadMethod } from '@/core/dapp/eip1193'

export const EVM_RPC_ERROR_CODES = Object.freeze([
  'cancelled',
  'timeout',
  'network-unavailable',
  'rate-limited',
  'unauthorized',
  'invalid-response',
  'chain-mismatch',
  'rpc-error'
] as const)

export type EvmRpcErrorCode = (typeof EVM_RPC_ERROR_CODES)[number]

export class EvmRpcError extends Error {
  readonly code: EvmRpcErrorCode
  readonly rpcCode?: number
  readonly rpcMessage?: string
  readonly rpcMethod?: string

  constructor(
    code: EvmRpcErrorCode,
    message: string,
    rpcError?: Readonly<{ code: number; message: string }>,
    rpcMethod?: string
  ) {
    super(message)
    this.name = 'EvmRpcError'
    this.code = code
    this.rpcCode = rpcError?.code
    this.rpcMessage = rpcError?.message
    this.rpcMethod = rpcMethod
  }
}

export interface EvmRpcClientConfig {
  readonly chainId: string
  readonly rpcUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface EvmBalanceRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getNativeBalance: (address: string, signal?: AbortSignal) => Promise<string>
  readonly getErc20Balance: (
    contract: string,
    address: string,
    signal?: AbortSignal
  ) => Promise<string>
}

export interface EvmContractRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getCode: (address: string, signal?: AbortSignal) => Promise<string>
  readonly callContract: (address: string, data: string, signal?: AbortSignal) => Promise<string>
}

export interface EvmRpcCall {
  readonly from: string
  readonly to: string
  readonly valueRaw: string
  readonly data: string
}

export type EvmRpcBlockTag = 'latest' | 'pending'

export interface EvmDAppRpcCall {
  readonly from?: string
  readonly to: string
  readonly valueRaw: string
  readonly data: string
}

export interface EvmDAppReadRpc {
  readonly requestDAppRead: (
    method: EvmDAppReadMethod,
    params: readonly unknown[] | Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ) => Promise<unknown>
  readonly getCode: (address: string, signal?: AbortSignal) => Promise<string>
  readonly call: (
    call: EvmDAppRpcCall,
    blockTag: EvmRpcBlockTag,
    signal?: AbortSignal
  ) => Promise<string>
  readonly getTransactionCount: (
    address: string,
    blockTag: EvmRpcBlockTag,
    signal?: AbortSignal
  ) => Promise<string>
  readonly estimateGas: (call: EvmDAppRpcCall, signal?: AbortSignal) => Promise<string>
}

export interface EvmLatestBlockFee {
  readonly blockNumber: string
  readonly baseFeePerGas: string
}

export interface EvmTransactionRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getNativeBalance: (address: string, signal?: AbortSignal) => Promise<string>
  readonly getPendingNonce: (address: string, signal?: AbortSignal) => Promise<string>
  readonly simulateCall: (call: EvmRpcCall, signal?: AbortSignal) => Promise<string>
  readonly estimateGas: (call: EvmRpcCall, signal?: AbortSignal) => Promise<string>
  readonly getMaximumPriorityFeePerGas: (signal?: AbortSignal) => Promise<string>
  readonly getLatestBlockFee: (signal?: AbortSignal) => Promise<EvmLatestBlockFee>
}

export interface EvmTransactionReceipt {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockNumber: string
  readonly status: 'success' | 'failed'
  readonly logs?: readonly EvmReceiptLog[]
}

export interface EvmReceiptLog {
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
}

export type EvmTransactionLocation =
  | { readonly status: 'unknown' }
  | { readonly status: 'pending' }
  | {
      readonly status: 'included'
      readonly blockHash: string
      readonly blockNumber: string
    }

export interface EvmBroadcastRpc {
  readonly broadcastRawTransaction: (
    rawTransaction: string,
    signal?: AbortSignal
  ) => Promise<string>
  readonly getTransactionReceipt: (
    transactionHash: string,
    signal?: AbortSignal
  ) => Promise<EvmTransactionReceipt | null>
  readonly getTransactionLocation: (
    transactionHash: string,
    signal?: AbortSignal
  ) => Promise<EvmTransactionLocation>
  readonly hasTransaction: (transactionHash: string, signal?: AbortSignal) => Promise<boolean>
  readonly getFinalizedBlockNumber: (signal?: AbortSignal) => Promise<string>
}

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024

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

function parseRpcUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid EVM RPC URL')
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
    throw new Error('EVM RPC URL must be a credential-free HTTPS endpoint')
  }
  return url.toString()
}

function parseExpectedChainId(value: string): { readonly caip2: string; readonly numeric: bigint } {
  const parsed = parseChainId(value)
  if (parsed.namespace !== 'eip155' || !/^(0|[1-9][0-9]*)$/.test(parsed.reference)) {
    throw new Error('Invalid EVM chain ID')
  }
  return Object.freeze({ caip2: parsed.id, numeric: BigInt(parsed.reference) })
}

function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  const parsed = BigInt(value)
  if (parsed.toString().length > 128) {
    throw new EvmRpcError('invalid-response', `${label} exceeds the supported range`)
  }
  return parsed
}

function parseAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseData(value: string, label: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || value.length > 2 + 128 * 1024 * 2) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  return value.toLowerCase()
}

function parseRawAmount(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error(`Invalid ${label}`)
  const amount = BigInt(value)
  if (amount >= 1n << 256n) throw new Error(`Invalid ${label}`)
  return amount
}

function toRpcQuantity(value: bigint): string {
  return `0x${value.toString(16)}`
}

function rpcCall(call: EvmDAppRpcCall): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(call.from === undefined ? {} : { from: parseAddress(call.from, 'EVM call sender') }),
    to: parseAddress(call.to, 'EVM call recipient'),
    value: toRpcQuantity(parseRawAmount(call.valueRaw, 'EVM call value')),
    data: parseData(call.data, 'EVM call data')
  })
}

function parseRpcError(value: unknown, method: string): EvmRpcError {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'message'], ['data']) ||
    !Number.isSafeInteger(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 4_096
  ) {
    return new EvmRpcError('invalid-response', 'Invalid EVM RPC error response', undefined, method)
  }
  return new EvmRpcError(
    value.code === -32_005 || value.code === -32_016 ? 'rate-limited' : 'rpc-error',
    'EVM RPC request failed',
    { code: value.code as number, message: value.message },
    method
  )
}

function mapHttpError(status: number, method: string): EvmRpcError {
  if (status === 401 || status === 403) {
    return new EvmRpcError('unauthorized', 'EVM RPC authorization failed', undefined, method)
  }
  if (status === 429) {
    return new EvmRpcError('rate-limited', 'EVM RPC rate limit exceeded', undefined, method)
  }
  return new EvmRpcError(
    'network-unavailable',
    'EVM RPC endpoint is unavailable',
    undefined,
    method
  )
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new EvmRpcError('invalid-response', 'EVM RPC response exceeds the allowed size')
  )
}

export function createEvmRpcClient(
  config: EvmRpcClientConfig,
  fetchImplementation: FetchImplementation = fetch
): EvmBalanceRpc & EvmContractRpc & EvmTransactionRpc & EvmBroadcastRpc & EvmDAppReadRpc {
  const expectedChain = parseExpectedChainId(config.chainId)
  const rpcUrl = parseRpcUrl(config.rpcUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid EVM RPC timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid EVM RPC response limit')
  }

  let requestId = 0

  const request = async (
    method:
      | EvmDAppReadMethod
      | 'eth_chainId'
      | 'eth_getCode'
      | 'eth_getBalance'
      | 'eth_call'
      | 'eth_getTransactionCount'
      | 'eth_estimateGas'
      | 'eth_maxPriorityFeePerGas'
      | 'eth_getBlockByNumber'
      | 'eth_sendRawTransaction'
      | 'eth_getTransactionByHash'
      | 'eth_getTransactionReceipt',
    params: readonly unknown[] | Readonly<Record<string, unknown>>,
    externalSignal?: AbortSignal
  ): Promise<unknown> => {
    if (externalSignal?.aborted) {
      throw new EvmRpcError('cancelled', 'EVM RPC request was cancelled', undefined, method)
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
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw mapHttpError(response.status, method)
      const text = await readResponseText(response, maximumResponseBytes)
      let decoded: unknown
      try {
        decoded = JSON.parse(text)
      } catch {
        throw new EvmRpcError('invalid-response', 'EVM RPC response is not valid JSON')
      }
      if (!isRecord(decoded) || decoded.jsonrpc !== '2.0' || decoded.id !== id) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM RPC response envelope')
      }
      if (Object.prototype.hasOwnProperty.call(decoded, 'error')) {
        if (!hasExactKeys(decoded, ['jsonrpc', 'id', 'error'])) {
          throw new EvmRpcError('invalid-response', 'Invalid EVM RPC error envelope')
        }
        throw parseRpcError(decoded.error, method)
      }
      if (!hasExactKeys(decoded, ['jsonrpc', 'id', 'result'])) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM RPC result envelope')
      }
      return decoded.result
    } catch (error) {
      if (error instanceof EvmRpcError) throw error
      if (controller.signal.aborted) {
        throw new EvmRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'EVM RPC request timed out' : 'EVM RPC request was cancelled',
          undefined,
          method
        )
      }
      throw new EvmRpcError('network-unavailable', 'EVM RPC request failed', undefined, method)
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  const assertExpectedChain = async (signal?: AbortSignal) => {
    const actualChainId = parseQuantity(await request('eth_chainId', [], signal), 'chain ID')
    if (actualChainId !== expectedChain.numeric) {
      throw new EvmRpcError('chain-mismatch', 'EVM RPC endpoint returned the wrong chain')
    }
  }

  const getTransactionLocation = async (
    transactionHash: string,
    signal?: AbortSignal
  ): Promise<EvmTransactionLocation> => {
    const expectedHash = parseHash(transactionHash, 'transaction hash')
    const result = await request('eth_getTransactionByHash', [expectedHash], signal)
    if (result === null) return Object.freeze({ status: 'unknown' })
    if (!isRecord(result)) {
      throw new EvmRpcError('invalid-response', 'Invalid EVM transaction response')
    }
    if (parseHash(result.hash, 'transaction hash') !== expectedHash) {
      throw new EvmRpcError('invalid-response', 'EVM transaction hash does not match')
    }
    if (result.blockHash === null && result.blockNumber === null) {
      return Object.freeze({ status: 'pending' })
    }
    if (result.blockHash === null || result.blockNumber === null) {
      throw new EvmRpcError('invalid-response', 'Invalid EVM transaction inclusion')
    }
    return Object.freeze({
      status: 'included',
      blockHash: parseHash(result.blockHash, 'transaction block hash'),
      blockNumber: parseQuantity(result.blockNumber, 'transaction block number').toString()
    })
  }

  const call = async (
    call: EvmDAppRpcCall,
    blockTag: EvmRpcBlockTag,
    signal?: AbortSignal
  ): Promise<string> => {
    const result = await request('eth_call', [rpcCall(call), blockTag], signal)
    if (
      typeof result !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(result) ||
      result.length > 2 + 128 * 1024 * 2
    ) {
      throw new EvmRpcError('invalid-response', 'Invalid EVM contract call response')
    }
    return result.toLowerCase()
  }

  const getTransactionCount = async (
    address: string,
    blockTag: EvmRpcBlockTag,
    signal?: AbortSignal
  ): Promise<string> =>
    parseQuantity(
      await request(
        'eth_getTransactionCount',
        [parseAddress(address, 'EVM address'), blockTag],
        signal
      ),
      'transaction count'
    ).toString()

  return Object.freeze({
    assertExpectedChain,
    requestDAppRead: async (
      method: EvmDAppReadMethod,
      params: readonly unknown[] | Readonly<Record<string, unknown>>,
      signal?: AbortSignal
    ) => request(method, params, signal),
    getNativeBalance: async (address: string, signal?: AbortSignal) =>
      parseQuantity(
        await request('eth_getBalance', [parseAddress(address, 'EVM address'), 'latest'], signal),
        'native balance'
      ).toString(),
    getErc20Balance: async (contract: string, address: string, signal?: AbortSignal) => {
      const parsedContract = parseAddress(contract, 'ERC-20 contract')
      const parsedAddress = parseAddress(address, 'EVM address')
      const data = `0x70a08231${parsedAddress.slice(2).padStart(64, '0')}`
      const result = await request('eth_call', [{ to: parsedContract, data }, 'latest'], signal)
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
        throw new EvmRpcError('invalid-response', 'Invalid ERC-20 balance response')
      }
      return BigInt(result).toString()
    },
    getCode: async (address: string, signal?: AbortSignal) => {
      const result = await request(
        'eth_getCode',
        [parseAddress(address, 'EVM contract'), 'latest'],
        signal
      )
      if (
        typeof result !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(result) ||
        result.length > 2 + 128 * 1024 * 2
      ) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM contract code response')
      }
      return result.toLowerCase()
    },
    callContract: async (address: string, data: string, signal?: AbortSignal) => {
      const result = await request(
        'eth_call',
        [
          { to: parseAddress(address, 'EVM contract'), data: parseData(data, 'EVM call data') },
          'latest'
        ],
        signal
      )
      if (
        typeof result !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(result) ||
        result.length > 2 + 128 * 1024 * 2
      ) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM contract call response')
      }
      return result.toLowerCase()
    },
    getTransactionCount,
    getPendingNonce: (address: string, signal?: AbortSignal) =>
      getTransactionCount(address, 'pending', signal),
    call,
    simulateCall: (rpcCall: EvmRpcCall, signal?: AbortSignal) => call(rpcCall, 'pending', signal),
    estimateGas: async (call: EvmDAppRpcCall, signal?: AbortSignal) =>
      parseQuantity(
        await request('eth_estimateGas', [rpcCall(call)], signal),
        'gas estimate'
      ).toString(),
    getMaximumPriorityFeePerGas: async (signal?: AbortSignal) =>
      parseQuantity(
        await request('eth_maxPriorityFeePerGas', [], signal),
        'maximum priority fee per gas'
      ).toString(),
    getLatestBlockFee: async (signal?: AbortSignal) => {
      const result = await request('eth_getBlockByNumber', ['latest', false], signal)
      if (!isRecord(result)) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM latest block response')
      }
      return Object.freeze({
        blockNumber: parseQuantity(result.number, 'latest block number').toString(),
        baseFeePerGas: parseQuantity(result.baseFeePerGas, 'latest base fee per gas').toString()
      })
    },
    broadcastRawTransaction: async (rawTransaction: string, signal?: AbortSignal) => {
      if (
        !/^0x(?:[0-9a-f]{2})+$/.test(rawTransaction) ||
        rawTransaction.length > 2 + 128 * 1024 * 2
      ) {
        throw new Error('Invalid signed EVM transaction')
      }
      return parseHash(
        await request('eth_sendRawTransaction', [rawTransaction], signal),
        'broadcast transaction hash'
      )
    },
    getTransactionReceipt: async (transactionHash: string, signal?: AbortSignal) => {
      const result = await request(
        'eth_getTransactionReceipt',
        [parseHash(transactionHash, 'transaction hash')],
        signal
      )
      if (result === null) return null
      if (!isRecord(result)) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM transaction receipt')
      }
      const status = parseQuantity(result.status, 'transaction receipt status')
      if (status !== 0n && status !== 1n) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM transaction receipt status')
      }
      const receiptHash = parseHash(result.transactionHash, 'receipt transaction hash')
      if (!Array.isArray(result.logs) || result.logs.length > 4_096) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM receipt logs')
      }
      const logs = result.logs.map((value: unknown): EvmReceiptLog => {
        if (
          !isRecord(value) ||
          typeof value.address !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(value.address) ||
          !Array.isArray(value.topics) ||
          value.topics.length > 4 ||
          typeof value.data !== 'string' ||
          !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data) ||
          value.data.length > 2 + 128 * 1024 * 2 ||
          (value.transactionHash !== undefined &&
            parseHash(value.transactionHash, 'receipt log transaction hash') !== receiptHash)
        ) {
          throw new EvmRpcError('invalid-response', 'Invalid EVM receipt log')
        }
        return Object.freeze({
          address: value.address.toLowerCase(),
          topics: Object.freeze(
            value.topics.map((topic: unknown) => parseHash(topic, 'receipt log topic'))
          ),
          data: value.data.toLowerCase()
        })
      })
      return Object.freeze({
        transactionHash: receiptHash,
        blockHash: parseHash(result.blockHash, 'receipt block hash'),
        blockNumber: parseQuantity(result.blockNumber, 'receipt block number').toString(),
        status: status === 1n ? 'success' : 'failed',
        logs: Object.freeze(logs)
      })
    },
    getTransactionLocation,
    hasTransaction: async (transactionHash: string, signal?: AbortSignal) =>
      (await getTransactionLocation(transactionHash, signal)).status !== 'unknown',
    getFinalizedBlockNumber: async (signal?: AbortSignal) => {
      const result = await request('eth_getBlockByNumber', ['finalized', false], signal)
      if (!isRecord(result)) {
        throw new EvmRpcError('invalid-response', 'Invalid EVM finalized block response')
      }
      return parseQuantity(result.number, 'finalized block number').toString()
    }
  })
}
