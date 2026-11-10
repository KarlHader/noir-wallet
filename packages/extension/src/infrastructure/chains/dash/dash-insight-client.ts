import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { parseChainId } from '@/core/chains/registry'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import bs58check from 'bs58check'
import {
  DASH_INSIGHT_MAX_ADDRESSES,
  resolveDashInsightNetwork,
  type DashInsightNetworkIdentity
} from './config'
import {
  assertDashInsightNetwork,
  DashRpcError,
  parseDashAddressTransactions,
  parseDashBlockIndex,
  parseDashBroadcastResult,
  parseDashInsightStatus,
  parseDashRawTransaction,
  parseDashTransaction,
  parseDashUtxos,
  type DashAddressTransactionPage,
  type DashInsightStatus,
  type DashTransaction,
  type DashUtxo
} from './dash-insight-codecs'

export {
  DASH_RPC_ERROR_CODES,
  DashRpcError,
  type DashAddressTransactionPage,
  type DashInsightStatus,
  type DashRpcErrorCode,
  type DashTransaction,
  type DashTransactionInput,
  type DashTransactionOutput,
  type DashUtxo
} from './dash-insight-codecs'

export interface DashInsightClientConfig {
  readonly chainId: string
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface DashInsightRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getTipHeight: (signal?: AbortSignal) => Promise<number>
  readonly getNetworkFeeRate: (signal?: AbortSignal) => Promise<string>
  readonly getAddressUtxos: (
    addresses: readonly string[],
    signal?: AbortSignal
  ) => Promise<readonly DashUtxo[]>
  readonly getAddressTransactions: (
    address: string,
    pageNum: number,
    signal?: AbortSignal
  ) => Promise<DashAddressTransactionPage>
  readonly getTransaction: (transactionId: string, signal?: AbortSignal) => Promise<DashTransaction>
  readonly getRawTransaction: (transactionId: string, signal?: AbortSignal) => Promise<string>
  readonly broadcastRawTransaction: (
    rawTransactionHex: string,
    signal?: AbortSignal
  ) => Promise<string>
}

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024
const MAXIMUM_RAW_TRANSACTION_HEX_CHARS = 200_000
const TRANSACTION_ID = /^[0-9a-f]{64}$/
const RAW_TRANSACTION = /^(?:[0-9a-f]{2})+$/

function parseBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Dash Insight URL')
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
    throw new Error('Dash Insight URL must be a credential-free HTTPS endpoint')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function parseExpectedNetwork(value: string): DashInsightNetworkIdentity {
  const chainId = parseChainId(value).id
  return resolveDashInsightNetwork(chainId)
}

function parseDashAddress(value: string, network: DashInsightNetworkIdentity): string {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Invalid Dash address')
  let decoded: Uint8Array
  try {
    decoded = bs58check.decode(value)
  } catch {
    throw new Error('Invalid Dash address')
  }
  if (
    decoded.length !== 21 ||
    (decoded[0] !== network.p2pkhVersion && decoded[0] !== network.p2shVersion) ||
    bs58check.encode(decoded) !== value
  ) {
    throw new Error('Invalid Dash address')
  }
  return value
}

function parseAddressBatch(
  addresses: readonly string[],
  network: DashInsightNetworkIdentity
): readonly string[] {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('Dash Insight address query requires an address')
  }
  if (addresses.length > DASH_INSIGHT_MAX_ADDRESSES) {
    throw new Error(`Dash Insight address query exceeds ${DASH_INSIGHT_MAX_ADDRESSES} addresses`)
  }
  const parsed = addresses.map(address => parseDashAddress(address, network))
  if (new Set(parsed).size !== parsed.length) throw new Error('Duplicate Dash address')
  return Object.freeze(parsed)
}

function parseTransactionId(value: string): string {
  if (typeof value !== 'string' || !TRANSACTION_ID.test(value)) {
    throw new Error('Invalid Dash transaction ID')
  }
  return value
}

function parsePageNum(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error('Invalid Dash transaction page')
  }
  return value
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

function mapHttpError(response: Response): DashRpcError {
  const status = response.status
  if (status === 401 || status === 403) {
    return new DashRpcError('unauthorized', 'Dash RPC authorization failed')
  }
  if (status === 404) return new DashRpcError('not-found', 'Dash RPC resource was not found')
  if (status === 429) {
    return new DashRpcError(
      'rate-limited',
      'Dash RPC rate limit exceeded',
      parseRetryAfterMs(response.headers.get('retry-after'))
    )
  }
  return new DashRpcError('network-unavailable', 'Dash RPC endpoint is unavailable')
}

function assertTransactionAddresses(
  transaction: DashTransaction,
  network: DashInsightNetworkIdentity
): void {
  try {
    for (const input of transaction.inputs) {
      if (input.address !== undefined) parseDashAddress(input.address, network)
    }
    for (const output of transaction.outputs) {
      for (const address of output.addresses) parseDashAddress(address, network)
    }
  } catch (error) {
    if (error instanceof DashRpcError) throw error
    throw new DashRpcError('invalid-response', 'Invalid Dash address')
  }
}

export function createDashInsightClient(
  config: DashInsightClientConfig,
  fetchImplementation: FetchImplementation = fetch
): DashInsightRpc {
  const network = parseExpectedNetwork(config.chainId)
  const baseUrl = parseBaseUrl(config.baseUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid Dash RPC timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid Dash RPC response limit')
  }

  const request = async (
    path: string,
    init: Pick<RequestInit, 'method' | 'headers' | 'body'>,
    externalSignal?: AbortSignal
  ): Promise<string> => {
    if (externalSignal?.aborted) {
      throw new DashRpcError('cancelled', 'Dash RPC request was cancelled')
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
      return await readBoundedResponseText(
        response,
        maximumResponseBytes,
        () => new DashRpcError('invalid-response', 'Dash RPC response exceeds the allowed size')
      )
    } catch (error) {
      if (error instanceof DashRpcError) throw error
      if (controller.signal.aborted) {
        throw new DashRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'Dash RPC request timed out' : 'Dash RPC request was cancelled'
        )
      }
      throw new DashRpcError('network-unavailable', 'Dash RPC request failed')
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  const getJson = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const text = await request(path, { method: 'GET' }, signal)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new DashRpcError('invalid-response', 'Dash RPC response is not valid JSON')
    }
  }

  const readStatus = async (signal?: AbortSignal): Promise<DashInsightStatus> => {
    const text = await request('status?q=getInfo', { method: 'GET' }, signal)
    const status = parseDashInsightStatus(text)
    assertDashInsightNetwork(status, network)
    return status
  }

  return Object.freeze({
    assertExpectedChain: async (signal?: AbortSignal) => {
      parseDashBlockIndex(await getJson('block-index/0', signal), network.genesisHash)
      await readStatus(signal)
    },
    getTipHeight: async (signal?: AbortSignal) => (await readStatus(signal)).blocks,
    getNetworkFeeRate: async (signal?: AbortSignal) =>
      (await readStatus(signal)).relayFeeDuffsPerKb,
    getAddressUtxos: async (addresses: readonly string[], signal?: AbortSignal) => {
      const parsed = parseAddressBatch(addresses, network)
      return parseDashUtxos(
        await getJson(`addrs/${parsed.map(encodeURIComponent).join(',')}/utxo`, signal),
        parsed
      )
    },
    getAddressTransactions: async (address: string, pageNum: number, signal?: AbortSignal) => {
      const parsed = parseDashAddress(address, network)
      const page = parsePageNum(pageNum)
      const pageResult = parseDashAddressTransactions(
        await getJson(`txs?address=${encodeURIComponent(parsed)}&pageNum=${page}`, signal)
      )
      for (const transaction of pageResult.transactions) {
        assertTransactionAddresses(transaction, network)
      }
      return pageResult
    },
    getTransaction: async (transactionId: string, signal?: AbortSignal) => {
      const parsedId = parseTransactionId(transactionId)
      const transaction = parseDashTransaction(await getJson(`tx/${parsedId}`, signal))
      if (transaction.transactionId !== parsedId) {
        throw new DashRpcError('invalid-response', 'Dash transaction ID does not match')
      }
      assertTransactionAddresses(transaction, network)
      return transaction
    },
    getRawTransaction: async (transactionId: string, signal?: AbortSignal) => {
      const parsedId = parseTransactionId(transactionId)
      return parseDashRawTransaction(await getJson(`rawtx/${parsedId}`, signal))
    },
    broadcastRawTransaction: async (rawTransactionHex: string, signal?: AbortSignal) => {
      if (
        typeof rawTransactionHex !== 'string' ||
        !RAW_TRANSACTION.test(rawTransactionHex) ||
        rawTransactionHex.length > MAXIMUM_RAW_TRANSACTION_HEX_CHARS
      ) {
        throw new Error('Invalid signed Dash transaction')
      }
      const text = await request(
        'tx/send',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `rawtx=${rawTransactionHex}`
        },
        signal
      )
      let value: unknown
      try {
        value = JSON.parse(text) as unknown
      } catch {
        throw new DashRpcError('invalid-response', 'Dash RPC response is not valid JSON')
      }
      return parseDashBroadcastResult(value)
    }
  })
}

export async function attestDashInsightEndpoint(
  chainId: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<void> {
  await createDashInsightClient({ chainId, baseUrl }).assertExpectedChain(signal)
}
