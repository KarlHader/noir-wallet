import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { getPearlChainId, parseChainId } from '@/core/chains/registry'
import { parseSupportedPearlAddress } from '@/core/chains/pearl'
import type {
  PearlAddressActivity,
  PearlHistoryTransaction,
  PearlTransactionStatus,
  PearlUtxo
} from '@/core/chains/pearl'
import type { ChainId } from '@/core/chains/domain'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import type { PearlConfirmedSpend } from './pearl-conflict-detection'
import { PearlRpcError } from './pearl-blockbook-error'

export {
  PearlRpcError,
  PEARL_RPC_ERROR_CODES,
  type PearlRpcErrorCode
} from './pearl-blockbook-error'

export interface PearlBlockbookClientConfig {
  readonly chainId: string
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

export interface PearlDiscoveryRpc {
  readonly assertExpectedChain: (signal?: AbortSignal) => Promise<void>
  readonly getTipHeight: (signal?: AbortSignal) => Promise<number>
  readonly getAddressActivity: (
    address: string,
    signal?: AbortSignal
  ) => Promise<PearlAddressActivity>
  readonly getAddressUtxos: (address: string, signal?: AbortSignal) => Promise<readonly PearlUtxo[]>
}

export interface PearlTransactionRpc {
  readonly getFeeEstimates: (signal?: AbortSignal) => Promise<Readonly<Record<string, number>>>
  readonly broadcastRawTransaction: (
    rawTransactionHex: string,
    signal?: AbortSignal
  ) => Promise<string>
  readonly getTransactionStatus: (
    transactionId: string,
    signal?: AbortSignal
  ) => Promise<PearlTransactionStatus>
  readonly getRawTransaction: (transactionId: string, signal?: AbortSignal) => Promise<string>
}

export interface PearlActivityHistoryRpc {
  readonly getAddressTransactions: (
    address: string,
    signal?: AbortSignal
  ) => Promise<readonly PearlHistoryTransaction[]>
}

export interface PearlConflictRpc {
  readonly getAddressSpends: (
    address: string,
    signal?: AbortSignal
  ) => Promise<readonly PearlConfirmedSpend[]>
}

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024
const MAXIMUM_UTXOS = 10_000
const MAXIMUM_HISTORY = 1_000
const MAXIMUM_BLOCK_HEIGHT = 2_147_483_647
const MAXIMUM_RAW_TRANSACTION_BYTES = 1024 * 1024
const MINIMUM_FEE_RATE_SATS_PER_VBYTE = 1

const PEARL_NETWORKS = Object.freeze({
  [getPearlChainId('mainnet')]: Object.freeze({
    coin: 'Pearl',
    backendChain: 'mainnet',
    caip2Reference: 'a18d3093b7ff618f0cdd073fa3d10374'
  }),
  [getPearlChainId('testnet')]: Object.freeze({
    genesisHash: 'b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96',
    coin: 'Pearl Testnet2',
    backendChain: 'testnet2',
    caip2Reference: 'b0c86d0cd8825f4d72260d2de46f4704'
  })
} as const)

interface PearlNetworkIdentity {
  readonly chainId: ChainId
  readonly coin: string
  readonly backendChain: string
  readonly caip2Reference: string
  readonly genesisHash?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseExpectedNetwork(value: string): PearlNetworkIdentity {
  const chainId = parseChainId(value).id
  if (!Object.prototype.hasOwnProperty.call(PEARL_NETWORKS, chainId)) {
    throw new Error('Invalid Pearl chain ID')
  }
  const networkKey = chainId as keyof typeof PEARL_NETWORKS
  return Object.freeze({ chainId, ...PEARL_NETWORKS[networkKey] })
}

function parseBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Pearl Blockbook URL')
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
    throw new Error('Pearl Blockbook URL must be a credential-free HTTPS endpoint')
  }
  return url.toString().replace(/\/+$/, '')
}

function parseSafeInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new PearlRpcError('invalid-response', `Invalid ${label}`)
  }
  return value as number
}

function parseUnsignedDecimal(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return value
  }
  throw new PearlRpcError('invalid-response', `Invalid ${label}`)
}

function parseTransactionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PearlRpcError('invalid-response', `Invalid ${label}`)
  }
  return value
}

/** Blockbook may return a bare txid, a JSON string, or `{ result|txid }` / `{ error }`. */
function parseBroadcastTransactionId(responseText: string): string {
  const trimmed = responseText.trim()
  const unquoted = trimmed.replace(/^"|"$/g, '')
  if (/^[0-9a-fA-F]{64}$/.test(unquoted)) return unquoted.toLowerCase()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string' && /^[0-9a-fA-F]{64}$/.test(parsed)) {
      return parsed.toLowerCase()
    }
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
        throw new PearlRpcError(
          'invalid-response',
          `Pearl broadcast failed: ${parsed.error.trim().slice(0, 160)}`
        )
      }
      const candidate = parsed.result ?? parsed.txid ?? parsed.txId
      if (typeof candidate === 'string' && /^[0-9a-fA-F]{64}$/.test(candidate)) {
        return candidate.toLowerCase()
      }
    }
  } catch (error) {
    if (error instanceof PearlRpcError) throw error
  }
  throw new PearlRpcError('invalid-response', 'Invalid Pearl broadcast transaction ID')
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const normalized = value.trim()
  if (/^[0-9]+$/.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  }
  const retryAt = Date.parse(normalized)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, retryAt - Date.now())
}

function mapHttpError(response: Response): PearlRpcError {
  const status = response.status
  if (status === 401 || status === 403) {
    return new PearlRpcError('unauthorized', 'Pearl RPC authorization failed')
  }
  if (status === 404) return new PearlRpcError('not-found', 'Pearl RPC resource was not found')
  if (status === 429) {
    return new PearlRpcError(
      'rate-limited',
      'Pearl RPC rate limit exceeded',
      parseRetryAfterMs(response.headers.get('retry-after'))
    )
  }
  return new PearlRpcError('network-unavailable', 'Pearl RPC endpoint is unavailable')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new PearlRpcError('invalid-response', 'Pearl RPC response is not valid JSON')
  }
}

function parseTransactionStatusFromBlockbook(value: unknown): PearlTransactionStatus {
  if (!isRecord(value)) {
    throw new PearlRpcError('invalid-response', 'Invalid Pearl transaction status')
  }
  const confirmations =
    value.confirmations === undefined
      ? 0
      : parseSafeInteger(value.confirmations, 'Pearl confirmations', MAXIMUM_BLOCK_HEIGHT)
  if (confirmations <= 0) return Object.freeze({ confirmed: false })
  const blockHeight = parseSafeInteger(
    value.blockHeight ?? value.height,
    'Pearl transaction block height',
    MAXIMUM_BLOCK_HEIGHT
  )
  const blockHash =
    typeof value.blockHash === 'string' && /^[0-9a-f]{64}$/.test(value.blockHash)
      ? value.blockHash
      : undefined
  return Object.freeze({
    confirmed: true,
    blockHeight,
    ...(blockHash === undefined ? {} : { blockHash }),
    ...(value.blockTime === undefined
      ? {}
      : {
          blockTime: parseSafeInteger(
            value.blockTime,
            'Pearl transaction block time',
            Number.MAX_SAFE_INTEGER
          )
        })
  })
}

/** Blockbook returns pearl/kB; convert to sat/vB with a safe floor. */
function pearlPerKbToSatsPerVbyte(pearlPerKb: number): number {
  if (!Number.isFinite(pearlPerKb) || pearlPerKb < 0) {
    throw new PearlRpcError('invalid-response', 'Pearl fee estimate is invalid')
  }
  if (pearlPerKb === 0) return MINIMUM_FEE_RATE_SATS_PER_VBYTE
  return Math.max(MINIMUM_FEE_RATE_SATS_PER_VBYTE, Math.ceil((pearlPerKb * 100_000_000) / 1_000))
}

export function createPearlBlockbookClient(
  config: PearlBlockbookClientConfig,
  fetchImpl?: FetchImplementation
): PearlBlockbookClient {
  return new PearlBlockbookClient(config, fetchImpl)
}

export class PearlBlockbookClient
  implements PearlDiscoveryRpc, PearlTransactionRpc, PearlActivityHistoryRpc
{
  private readonly network: PearlNetworkIdentity
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maximumResponseBytes: number
  private readonly fetchImpl: FetchImplementation

  constructor(
    config: PearlBlockbookClientConfig,
    fetchImpl: FetchImplementation = globalThis.fetch.bind(globalThis)
  ) {
    this.network = parseExpectedNetwork(config.chainId)
    this.baseUrl = parseBaseUrl(config.baseUrl)
    this.timeoutMs = Math.min(
      Math.max(1, config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      MAXIMUM_TIMEOUT_MS
    )
    this.maximumResponseBytes = Math.min(
      Math.max(1, config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES),
      MAXIMUM_RESPONSE_BYTES
    )
    this.fetchImpl = fetchImpl
  }

  async assertExpectedChain(signal?: AbortSignal): Promise<void> {
    const status = await this.requestJson('', signal)
    if (!isRecord(status) || !isRecord(status.blockbook) || !isRecord(status.backend)) {
      throw new PearlRpcError('invalid-response', 'Pearl Blockbook status is invalid')
    }
    const coin = typeof status.blockbook.coin === 'string' ? status.blockbook.coin : ''
    const backendChain = typeof status.backend.chain === 'string' ? status.backend.chain : ''
    if (coin !== this.network.coin || backendChain !== this.network.backendChain) {
      throw new PearlRpcError('chain-mismatch', 'Pearl Blockbook network identity mismatch')
    }
    // Testnet CAIP-2 reference is the first 32 hex of the full genesis hash.
    if (
      this.network.genesisHash !== undefined &&
      this.network.chainId !== `bip122:${this.network.genesisHash.slice(0, 32)}`
    ) {
      throw new PearlRpcError('chain-mismatch', 'Pearl chain ID does not match testnet genesis')
    }
    const bestHash =
      typeof status.backend.bestBlockHash === 'string' ? status.backend.bestBlockHash : ''
    if (bestHash.length > 0 && !/^[0-9a-f]{64}$/.test(bestHash)) {
      throw new PearlRpcError('invalid-response', 'Pearl Blockbook tip hash is invalid')
    }
  }

  async getTipHeight(signal?: AbortSignal): Promise<number> {
    const status = await this.requestJson('', signal)
    if (!isRecord(status) || !isRecord(status.backend)) {
      throw new PearlRpcError('invalid-response', 'Pearl Blockbook tip is invalid')
    }
    return parseSafeInteger(status.backend.blocks, 'Pearl tip height', MAXIMUM_BLOCK_HEIGHT)
  }

  async getAddressActivity(address: string, signal?: AbortSignal): Promise<PearlAddressActivity> {
    const normalized = parseSupportedPearlAddress(address, this.network.chainId)
    const payload = await this.requestJson(
      `/address/${encodeURIComponent(normalized)}?details=basic`,
      signal
    )
    if (!isRecord(payload)) {
      throw new PearlRpcError('invalid-response', 'Pearl address activity is invalid')
    }
    const confirmedTransactionCount = parseSafeInteger(
      payload.txs ?? 0,
      'Pearl address transaction count'
    )
    const mempoolTransactionCount = parseSafeInteger(
      payload.unconfirmedTxs ?? 0,
      'Pearl address mempool transaction count'
    )
    const balanceSats = parseUnsignedDecimal(payload.balance ?? '0', 'Pearl address balance')
    return Object.freeze({
      confirmedTransactionCount,
      mempoolTransactionCount,
      used: confirmedTransactionCount > 0 || mempoolTransactionCount > 0 || balanceSats !== '0',
      balanceSats
    })
  }

  async getAddressUtxos(address: string, signal?: AbortSignal): Promise<readonly PearlUtxo[]> {
    const normalized = parseSupportedPearlAddress(address, this.network.chainId)
    const payload = await this.requestJson(`/utxo/${encodeURIComponent(normalized)}`, signal)
    if (!Array.isArray(payload) || payload.length > MAXIMUM_UTXOS) {
      throw new PearlRpcError('invalid-response', 'Pearl UTXO list is invalid')
    }
    return Object.freeze(
      payload.map((item, index) => {
        if (!isRecord(item)) {
          throw new PearlRpcError('invalid-response', `Pearl UTXO[${index}] is invalid`)
        }
        const confirmations =
          item.confirmations === undefined
            ? 0
            : parseSafeInteger(
                item.confirmations,
                `Pearl UTXO[${index}] confirmations`,
                MAXIMUM_BLOCK_HEIGHT
              )
        return Object.freeze({
          transactionId: parseTransactionId(item.txid, `Pearl UTXO[${index}] transaction ID`),
          outputIndex: parseSafeInteger(item.vout, `Pearl UTXO[${index}] output index`, 0xffffffff),
          valueSats: parseUnsignedDecimal(item.value, `Pearl UTXO[${index}] value`),
          address: normalized,
          status:
            confirmations > 0
              ? Object.freeze({
                  confirmed: true as const,
                  blockHeight: parseSafeInteger(
                    item.height ?? 0,
                    `Pearl UTXO[${index}] height`,
                    MAXIMUM_BLOCK_HEIGHT
                  )
                })
              : Object.freeze({ confirmed: false as const })
        })
      })
    )
  }

  async getAddressTransactions(
    address: string,
    signal?: AbortSignal
  ): Promise<readonly PearlHistoryTransaction[]> {
    const normalized = parseSupportedPearlAddress(address, this.network.chainId)
    const payload = await this.requestJson(
      `/address/${encodeURIComponent(normalized)}?details=txs&pageSize=${MAXIMUM_HISTORY}`,
      signal
    )
    if (!isRecord(payload)) {
      throw new PearlRpcError('invalid-response', 'Pearl address history is invalid')
    }
    const transactions = Array.isArray(payload.transactions)
      ? payload.transactions
      : Array.isArray(payload.txids)
        ? []
        : null
    if (transactions === null) {
      throw new PearlRpcError('invalid-response', 'Pearl address history is invalid')
    }
    if (transactions.length > MAXIMUM_HISTORY) {
      throw new PearlRpcError('invalid-response', 'Pearl address history exceeds the size limit')
    }
    return Object.freeze(
      transactions.map((item, index) => {
        if (!isRecord(item)) {
          throw new PearlRpcError('invalid-response', `Pearl history[${index}] is invalid`)
        }
        return Object.freeze({
          transactionId: parseTransactionId(item.txid, `Pearl history[${index}] transaction ID`),
          status: parseTransactionStatusFromBlockbook(item),
          ...(item.fees === undefined
            ? {}
            : { feeSats: parseUnsignedDecimal(item.fees, `Pearl history[${index}] fee`) }),
          ...(item.value === undefined
            ? {}
            : { valueSats: parseUnsignedDecimal(item.value, `Pearl history[${index}] value`) })
        })
      })
    )
  }

  async getAddressSpends(
    address: string,
    signal?: AbortSignal
  ): Promise<readonly PearlConfirmedSpend[]> {
    const normalized = parseSupportedPearlAddress(address, this.network.chainId)
    const payload = await this.requestJson(
      `/address/${encodeURIComponent(normalized)}?details=txs&pageSize=${MAXIMUM_HISTORY}`,
      signal
    )
    return this.parseAddressSpendsFrom(payload)
  }

  private parseAddressSpendsFrom(payload: unknown): readonly PearlConfirmedSpend[] {
    if (!isRecord(payload)) {
      throw new PearlRpcError('invalid-response', 'Pearl address history is invalid')
    }
    const transactions = Array.isArray(payload.transactions)
      ? payload.transactions
      : Array.isArray(payload.txids)
        ? []
        : null
    if (transactions === null) {
      throw new PearlRpcError('invalid-response', 'Pearl address history is invalid')
    }
    if (transactions.length > MAXIMUM_HISTORY) {
      throw new PearlRpcError('invalid-response', 'Pearl address history exceeds the size limit')
    }
    const spends: PearlConfirmedSpend[] = []
    for (const [index, item] of transactions.entries()) {
      if (!isRecord(item)) {
        throw new PearlRpcError('invalid-response', `Pearl history[${index}] is invalid`)
      }
      const confirmations = item.confirmations === undefined ? 0 : item.confirmations
      const blockHash = item.blockHash
      const blockHeight = item.blockHeight
      if (
        !Number.isSafeInteger(confirmations) ||
        (confirmations as number) < 0 ||
        (confirmations as number) > MAXIMUM_BLOCK_HEIGHT ||
        typeof blockHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(blockHash) ||
        !Number.isSafeInteger(blockHeight) ||
        (blockHeight as number) < 0 ||
        (blockHeight as number) > MAXIMUM_BLOCK_HEIGHT
      ) {
        // Unconfirmed entries cannot prove a finalized conflict.
        continue
      }
      if (!Array.isArray(item.vin) || item.vin.length === 0) continue
      const spentOutpoints: string[] = []
      for (const [inputIndex, input] of item.vin.entries()) {
        if (!isRecord(input)) {
          throw new PearlRpcError(
            'invalid-response',
            `Pearl history[${index}] input ${inputIndex} is invalid`
          )
        }
        if (input.txid === undefined && input.vout === undefined) continue
        const transactionId = parseTransactionId(
          input.txid,
          `Pearl history[${index}] input ${inputIndex} transaction ID`
        )
        const outputIndex = parseSafeInteger(
          input.vout,
          `Pearl history[${index}] input ${inputIndex} output index`,
          0xffffffff
        )
        spentOutpoints.push(`${transactionId}:${outputIndex}`)
      }
      if (spentOutpoints.length === 0) continue
      spends.push(
        Object.freeze({
          transactionId: parseTransactionId(item.txid, `Pearl history[${index}] transaction ID`),
          spentOutpoints: Object.freeze(spentOutpoints),
          confirmations: confirmations as number,
          blockHash,
          blockHeight: blockHeight as number
        })
      )
    }
    return Object.freeze(spends)
  }

  async getTransactionStatus(
    transactionId: string,
    signal?: AbortSignal
  ): Promise<PearlTransactionStatus> {
    const txid = parseTransactionId(transactionId, 'Pearl transaction ID')
    const payload = await this.requestJson(`/tx/${txid}`, signal)
    return parseTransactionStatusFromBlockbook(payload)
  }

  async getRawTransaction(transactionId: string, signal?: AbortSignal): Promise<string> {
    const txid = parseTransactionId(transactionId, 'Pearl transaction ID')
    const payload = await this.requestJson(`/tx/${txid}`, signal)
    if (!isRecord(payload) || typeof payload.hex !== 'string') {
      throw new PearlRpcError('invalid-response', 'Pearl raw transaction is invalid')
    }
    if (
      !/^[0-9a-f]+$/i.test(payload.hex) ||
      payload.hex.length / 2 > MAXIMUM_RAW_TRANSACTION_BYTES
    ) {
      throw new PearlRpcError('invalid-response', 'Pearl raw transaction hex is invalid')
    }
    return payload.hex.toLowerCase()
  }

  async broadcastRawTransaction(rawTransactionHex: string, signal?: AbortSignal): Promise<string> {
    if (
      typeof rawTransactionHex !== 'string' ||
      !/^[0-9a-f]+$/i.test(rawTransactionHex) ||
      rawTransactionHex.length / 2 > MAXIMUM_RAW_TRANSACTION_BYTES
    ) {
      throw new Error('Pearl raw transaction hex is invalid')
    }
    // Prefer POST body: GET /sendtx/<hex> exceeds URL limits for typical Taproot txs.
    const response = await this.requestText(
      '/sendtx/',
      {
        method: 'POST',
        headers: Object.freeze({ 'Content-Type': 'text/plain' }),
        body: rawTransactionHex.toLowerCase()
      },
      signal
    )
    return parseBroadcastTransactionId(response)
  }

  async getFeeEstimates(signal?: AbortSignal): Promise<Readonly<Record<string, number>>> {
    const estimates: Record<string, number> = {}
    for (const blocks of [1, 3, 6] as const) {
      const payload = await this.requestJson(`/estimatefee/${blocks}`, signal)
      if (!isRecord(payload) || typeof payload.result !== 'string') {
        throw new PearlRpcError('invalid-response', `Pearl fee estimate ${blocks} is invalid`)
      }
      estimates[String(blocks)] = pearlPerKbToSatsPerVbyte(Number(payload.result))
    }
    return Object.freeze(estimates)
  }

  private async requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return parseJson(await this.requestText(path, { method: 'GET' }, signal))
  }

  private async requestText(
    path: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: Object.freeze({ Accept: 'application/json', ...(init.headers ?? {}) })
      })
      if (!response.ok) throw mapHttpError(response)
      return await readBoundedResponseText(
        response,
        this.maximumResponseBytes,
        () => new PearlRpcError('invalid-response', 'Pearl RPC response exceeds the allowed size')
      )
    } catch (error) {
      if (error instanceof PearlRpcError) throw error
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw error
      }
      throw new PearlRpcError('network-unavailable', 'Pearl RPC request failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
