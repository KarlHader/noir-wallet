import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { getBitcoinChainId, parseChainId } from '@/core/chains/registry'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import type { ChainId } from '@/core/chains/domain'
import type {
  BitcoinAddressActivity,
  BitcoinTransactionStatus,
  BitcoinUtxo
} from '@/core/chains/bitcoin'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import { Transaction } from 'bitcoinjs-lib'
import { BitcoinRpcError } from './bitcoin-esplora-error'
import {
  parseBitcoinAddressHistory,
  type BitcoinHistoryTransaction
} from './bitcoin-esplora-history-model'

export {
  BITCOIN_RPC_ERROR_CODES,
  BitcoinRpcError,
  type BitcoinRpcErrorCode
} from './bitcoin-esplora-error'

export interface BitcoinEsploraClientConfig {
  readonly chainId: string
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface BitcoinDiscoveryRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getTipHeight: (signal?: AbortSignal) => Promise<number>
  readonly getAddressActivity: (
    address: string,
    signal?: AbortSignal
  ) => Promise<BitcoinAddressActivity>
  readonly getAddressUtxos: (
    address: string,
    signal?: AbortSignal
  ) => Promise<readonly BitcoinUtxo[]>
}

export interface BitcoinTransactionRpc {
  readonly getFeeEstimates: (signal?: AbortSignal) => Promise<Readonly<Record<string, number>>>
  readonly broadcastRawTransaction: (
    rawTransactionHex: string,
    signal?: AbortSignal
  ) => Promise<string>
  readonly getTransactionStatus: (
    transactionId: string,
    signal?: AbortSignal
  ) => Promise<BitcoinTransactionStatus>
  readonly getRawTransaction: (transactionId: string, signal?: AbortSignal) => Promise<string>
  readonly getOutputSpendStatus: (
    transactionId: string,
    outputIndex: number,
    signal?: AbortSignal
  ) => Promise<BitcoinOutputSpendStatus>
}

export type BitcoinOutputSpendStatus =
  | { readonly spent: false }
  | {
      readonly spent: true
      readonly spendingTransactionId: string
      readonly inputIndex: number
      readonly status: BitcoinTransactionStatus
    }

export interface BitcoinActivityHistoryRpc {
  readonly getAddressTransactions: (
    address: string,
    signal?: AbortSignal
  ) => Promise<readonly BitcoinHistoryTransaction[]>
}

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024
const MAXIMUM_UTXOS = 10_000
const MAXIMUM_FEE_TARGETS = 64
const MAXIMUM_RAW_TRANSACTION_BYTES = 1024 * 1024
const MAXIMUM_BLOCK_HEIGHT = 2_147_483_647

const BITCOIN_NETWORKS = Object.freeze({
  [getBitcoinChainId('mainnet')]: Object.freeze({
    genesisHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
  }),
  [getBitcoinChainId('testnet')]: Object.freeze({
    genesisHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
  })
} as const)

interface BitcoinNetworkIdentity {
  readonly chainId: ChainId
  readonly genesisHash: string
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

function parseExpectedNetwork(value: string): BitcoinNetworkIdentity {
  const chainId = parseChainId(value).id
  if (!Object.prototype.hasOwnProperty.call(BITCOIN_NETWORKS, chainId)) {
    throw new Error('Invalid Bitcoin chain ID')
  }
  const networkKey = chainId as keyof typeof BITCOIN_NETWORKS
  return Object.freeze({ chainId, ...BITCOIN_NETWORKS[networkKey] })
}

function parseBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Bitcoin Esplora URL')
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
    throw new Error('Bitcoin Esplora URL must be a credential-free HTTPS endpoint')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function parseTransactionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new BitcoinRpcError('invalid-response', `Invalid ${label}`)
  }
  return value
}

function parseSafeInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new BitcoinRpcError('invalid-response', `Invalid ${label}`)
  }
  return value as number
}

function parseBitcoinAddress(value: string, network: BitcoinNetworkIdentity): string {
  return parseSupportedBitcoinAddress(value, network.chainId)
}

function parseStats(value: unknown, label: string): { readonly transactionCount: number } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'tx_count',
      'funded_txo_count',
      'funded_txo_sum',
      'spent_txo_count',
      'spent_txo_sum'
    ])
  ) {
    throw new BitcoinRpcError('invalid-response', `Invalid ${label}`)
  }
  const fundedCount = parseSafeInteger(value.funded_txo_count, `${label} funded output count`)
  const spentCount = parseSafeInteger(value.spent_txo_count, `${label} spent output count`)
  if (spentCount > fundedCount) {
    throw new BitcoinRpcError('invalid-response', `Invalid ${label} output counts`)
  }
  parseSafeInteger(value.funded_txo_sum, `${label} funded amount`)
  parseSafeInteger(value.spent_txo_sum, `${label} spent amount`)
  return Object.freeze({
    transactionCount: parseSafeInteger(value.tx_count, `${label} transaction count`)
  })
}

function parseTransactionStatus(value: unknown): BitcoinTransactionStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['confirmed'], ['block_height', 'block_hash', 'block_time']) ||
    typeof value.confirmed !== 'boolean'
  ) {
    throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin transaction status')
  }
  if (!value.confirmed) {
    if (
      value.block_height !== undefined ||
      value.block_hash !== undefined ||
      value.block_time !== undefined
    ) {
      throw new BitcoinRpcError('invalid-response', 'Unconfirmed Bitcoin status has block data')
    }
    return Object.freeze({ confirmed: false })
  }
  return Object.freeze({
    confirmed: true,
    blockHeight: parseSafeInteger(
      value.block_height,
      'Bitcoin transaction block height',
      MAXIMUM_BLOCK_HEIGHT
    ),
    blockHash: parseTransactionId(value.block_hash, 'Bitcoin transaction block hash'),
    ...(value.block_time === undefined
      ? {}
      : {
          blockTime: parseSafeInteger(
            value.block_time,
            'Bitcoin transaction block time',
            Number.MAX_SAFE_INTEGER
          )
        })
  })
}

function parseOutputSpendStatus(value: unknown): BitcoinOutputSpendStatus {
  if (!isRecord(value) || typeof value.spent !== 'boolean') {
    throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin output spend status')
  }
  if (!value.spent) {
    if (!hasExactKeys(value, ['spent'])) {
      throw new BitcoinRpcError('invalid-response', 'Unspent Bitcoin output has spend data')
    }
    return Object.freeze({ spent: false })
  }
  if (!hasExactKeys(value, ['spent', 'txid', 'vin', 'status'])) {
    throw new BitcoinRpcError('invalid-response', 'Spent Bitcoin output is missing spend data')
  }
  return Object.freeze({
    spent: true,
    spendingTransactionId: parseTransactionId(value.txid, 'Bitcoin spending transaction ID'),
    inputIndex: parseSafeInteger(value.vin, 'Bitcoin spending input index', 0xffffffff),
    status: parseTransactionStatus(value.status)
  })
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const normalized = value.trim()
  if (/^[0-9]+$/.test(normalized)) {
    const seconds = Number(normalized)
    const milliseconds = seconds * 1_000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  }
  const retryAt = Date.parse(normalized)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, retryAt - Date.now())
}

function mapHttpError(response: Response): BitcoinRpcError {
  const status = response.status
  if (status === 401 || status === 403) {
    return new BitcoinRpcError('unauthorized', 'Bitcoin RPC authorization failed')
  }
  if (status === 404) return new BitcoinRpcError('not-found', 'Bitcoin RPC resource was not found')
  if (status === 429) {
    return new BitcoinRpcError(
      'rate-limited',
      'Bitcoin RPC rate limit exceeded',
      parseRetryAfterMs(response.headers.get('retry-after'))
    )
  }
  return new BitcoinRpcError('network-unavailable', 'Bitcoin RPC endpoint is unavailable')
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new BitcoinRpcError('invalid-response', 'Bitcoin RPC response exceeds the allowed size')
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new BitcoinRpcError('invalid-response', 'Bitcoin RPC response is not valid JSON')
  }
}

export function createBitcoinEsploraClient(
  config: BitcoinEsploraClientConfig,
  fetchImplementation: FetchImplementation = fetch
): BitcoinDiscoveryRpc & BitcoinTransactionRpc & BitcoinActivityHistoryRpc {
  const network = parseExpectedNetwork(config.chainId)
  const baseUrl = parseBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid Bitcoin RPC timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid Bitcoin RPC response limit')
  }

  const request = async (
    path: string,
    init: Pick<RequestInit, 'method' | 'headers' | 'body'>,
    externalSignal?: AbortSignal
  ): Promise<string> => {
    if (externalSignal?.aborted) {
      throw new BitcoinRpcError('cancelled', 'Bitcoin RPC request was cancelled')
    }
    const controller = new AbortController()
    let timedOut = false
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetchImplementation(new URL(path, baseUrl).toString(), {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw mapHttpError(response)
      return await readResponseText(response, maximumResponseBytes)
    } catch (error) {
      if (error instanceof BitcoinRpcError) throw error
      if (controller.signal.aborted) {
        throw new BitcoinRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'Bitcoin RPC request timed out' : 'Bitcoin RPC request was cancelled'
        )
      }
      throw new BitcoinRpcError('network-unavailable', 'Bitcoin RPC request failed')
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  const getJson = async (path: string, signal?: AbortSignal): Promise<unknown> =>
    parseJson(await request(path, { method: 'GET' }, signal))

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) => {
      const hash = (await request('block-height/0', { method: 'GET' }, signal)).trim()
      if (hash !== network.genesisHash) {
        throw new BitcoinRpcError('chain-mismatch', 'Bitcoin RPC endpoint returned the wrong chain')
      }
    },
    getTipHeight: async (signal?: AbortSignal) => {
      const text = (await request('blocks/tip/height', { method: 'GET' }, signal)).trim()
      if (!/^(0|[1-9][0-9]*)$/.test(text)) {
        throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin tip height')
      }
      return parseSafeInteger(Number(text), 'Bitcoin tip height', MAXIMUM_BLOCK_HEIGHT)
    },
    getAddressActivity: async (address: string, signal?: AbortSignal) => {
      const parsedAddress = parseBitcoinAddress(address, network)
      const value = await getJson(`address/${encodeURIComponent(parsedAddress)}`, signal)
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['address', 'chain_stats', 'mempool_stats']) ||
        value.address !== parsedAddress
      ) {
        throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin address response')
      }
      const confirmed = parseStats(value.chain_stats, 'Bitcoin confirmed address stats')
      const mempool = parseStats(value.mempool_stats, 'Bitcoin mempool address stats')
      return Object.freeze({
        confirmedTransactionCount: confirmed.transactionCount,
        mempoolTransactionCount: mempool.transactionCount,
        used: confirmed.transactionCount > 0 || mempool.transactionCount > 0
      })
    },
    getAddressUtxos: async (address: string, signal?: AbortSignal) => {
      const parsedAddress = parseBitcoinAddress(address, network)
      const value = await getJson(`address/${encodeURIComponent(parsedAddress)}/utxo`, signal)
      if (!Array.isArray(value) || value.length > MAXIMUM_UTXOS) {
        throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin UTXO response')
      }
      return Object.freeze(
        value.map((item, index) => {
          if (!isRecord(item) || !hasExactKeys(item, ['txid', 'vout', 'value', 'status'])) {
            throw new BitcoinRpcError('invalid-response', `Invalid Bitcoin UTXO at ${index}`)
          }
          return Object.freeze({
            transactionId: parseTransactionId(item.txid, `Bitcoin UTXO ${index} transaction ID`),
            outputIndex: parseSafeInteger(
              item.vout,
              `Bitcoin UTXO ${index} output index`,
              0xffffffff
            ),
            valueRaw: parseSafeInteger(item.value, `Bitcoin UTXO ${index} value`).toString(),
            status: parseTransactionStatus(item.status)
          })
        })
      )
    },
    getAddressTransactions: async (address: string, signal?: AbortSignal) => {
      const parsedAddress = parseBitcoinAddress(address, network)
      return parseBitcoinAddressHistory(
        await getJson(`address/${encodeURIComponent(parsedAddress)}/txs`, signal)
      )
    },
    getFeeEstimates: async (signal?: AbortSignal) => {
      const value = await getJson('fee-estimates', signal)
      if (!isRecord(value) || Object.keys(value).length > MAXIMUM_FEE_TARGETS) {
        throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin fee estimates')
      }
      const estimates: Record<string, number> = {}
      for (const [target, feeRate] of Object.entries(value)) {
        if (
          !/^[1-9][0-9]{0,3}$/.test(target) ||
          Number(target) > 1_008 ||
          typeof feeRate !== 'number' ||
          !Number.isFinite(feeRate) ||
          feeRate <= 0 ||
          feeRate > 1_000_000
        ) {
          throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin fee estimate')
        }
        estimates[target] = feeRate
      }
      return Object.freeze(estimates)
    },
    broadcastRawTransaction: async (rawTransactionHex: string, signal?: AbortSignal) => {
      if (
        typeof rawTransactionHex !== 'string' ||
        !/^(?:[0-9a-f]{2})+$/.test(rawTransactionHex) ||
        rawTransactionHex.length > MAXIMUM_RAW_TRANSACTION_BYTES * 2
      ) {
        throw new Error('Invalid signed Bitcoin transaction')
      }
      return parseTransactionId(
        (
          await request(
            'tx',
            {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body: rawTransactionHex
            },
            signal
          )
        ).trim(),
        'broadcast Bitcoin transaction ID'
      )
    },
    getTransactionStatus: async (transactionId: string, signal?: AbortSignal) =>
      parseTransactionStatus(
        await getJson(
          `tx/${parseTransactionId(transactionId, 'Bitcoin transaction ID')}/status`,
          signal
        )
      ),
    getRawTransaction: async (transactionId: string, signal?: AbortSignal) => {
      const expectedId = parseTransactionId(transactionId, 'Bitcoin transaction ID')
      const rawTransactionHex = (
        await request(`tx/${expectedId}/hex`, { method: 'GET' }, signal)
      ).trim()
      if (
        !/^(?:[0-9a-f]{2})+$/.test(rawTransactionHex) ||
        rawTransactionHex.length > MAXIMUM_RAW_TRANSACTION_BYTES * 2
      ) {
        throw new BitcoinRpcError('invalid-response', 'Invalid raw Bitcoin transaction')
      }
      try {
        if (Transaction.fromHex(rawTransactionHex).getId() !== expectedId) {
          throw new Error('Transaction ID mismatch')
        }
      } catch {
        throw new BitcoinRpcError(
          'invalid-response',
          'Raw Bitcoin transaction does not match its ID'
        )
      }
      return rawTransactionHex
    },
    getOutputSpendStatus: async (
      transactionId: string,
      outputIndex: number,
      signal?: AbortSignal
    ) =>
      parseOutputSpendStatus(
        await getJson(
          `tx/${parseTransactionId(transactionId, 'Bitcoin transaction ID')}/outspend/${parseSafeInteger(
            outputIndex,
            'Bitcoin output index',
            0xffffffff
          )}`,
          signal
        )
      )
  })
}
