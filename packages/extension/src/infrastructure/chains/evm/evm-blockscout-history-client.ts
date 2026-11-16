import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { EvmRpcError } from './evm-rpc-client'
import {
  EVM_HISTORY_LIMIT,
  mapEvmIndexedActivity,
  type EvmActivityHistorySource,
  type FindEvmConfirmedReplacementInput,
  type IndexedTransaction,
  type IndexedTokenTransfer,
  type ReadEvmAddressActivityInput,
  type TrackedErc20Asset
} from './evm-indexed-activity'

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
const MAXIMUM_TIMEOUT_MS = 60_000
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024
const MAXIMUM_UINT256 = 1n << 256n

interface EvmBlockscoutHistoryClientConfig {
  readonly chainId: string
  readonly apiUrl: string
  readonly nativeAssetId: string
  readonly trackedErc20Assets: readonly TrackedErc20Asset[]
  readonly readFinalizedBlockNumber: (signal?: AbortSignal) => Promise<string>
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseApiUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid EVM history API URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('EVM history API must be a credential-free HTTPS endpoint')
  }
  return url.toString()
}

function parseAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  return value.toLowerCase()
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  return value.toLowerCase()
}

function parseUnsignedDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new EvmRpcError('invalid-response', `Invalid ${label}`)
  }
  if (BigInt(value) >= MAXIMUM_UINT256) {
    throw new EvmRpcError('invalid-response', `${label} exceeds uint256`)
  }
  return value
}

function parseSafeIntegerString(value: unknown, label: string): number {
  const parsed = parseUnsignedDecimal(value, label)
  const number = Number(parsed)
  if (!Number.isSafeInteger(number)) {
    throw new EvmRpcError('invalid-response', `${label} exceeds the supported range`)
  }
  return number
}

function parseTimestamp(value: unknown): number {
  const seconds = parseSafeIntegerString(value, 'EVM history timestamp')
  const milliseconds = seconds * 1_000
  if (!Number.isSafeInteger(milliseconds)) {
    throw new EvmRpcError('invalid-response', 'EVM history timestamp exceeds the supported range')
  }
  return milliseconds
}

function parseOptionalCalldata(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length > 131_074 ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  ) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history calldata')
  }
  return value.toLowerCase()
}

function parseNormalTransaction(value: unknown): IndexedTransaction {
  if (!isRecord(value)) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history transaction')
  }
  const to = value.to === '' ? undefined : parseAddress(value.to, 'EVM history recipient')
  if (value.isError !== '0' && value.isError !== '1') {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history failure status')
  }
  if (value.txreceipt_status !== '0' && value.txreceipt_status !== '1') {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history receipt status')
  }
  return Object.freeze({
    transactionHash: parseHash(value.hash, 'EVM history transaction hash'),
    blockHash: parseHash(value.blockHash, 'EVM history block hash'),
    blockHeight: parseSafeIntegerString(value.blockNumber, 'EVM history block number'),
    confirmations: parseSafeIntegerString(value.confirmations, 'EVM history confirmations'),
    from: parseAddress(value.from, 'EVM history sender'),
    ...(to === undefined ? {} : { to }),
    valueRaw: parseUnsignedDecimal(value.value, 'EVM history value'),
    gasPriceRaw: parseUnsignedDecimal(value.gasPrice, 'EVM history gas price'),
    gasUsed: parseUnsignedDecimal(value.gasUsed, 'EVM history gas used'),
    nonce: parseUnsignedDecimal(value.nonce, 'EVM history nonce'),
    timestamp: parseTimestamp(value.timeStamp),
    failed: value.isError === '1' || value.txreceipt_status === '0',
    ...(value.input === undefined ? {} : { input: parseOptionalCalldata(value.input) })
  })
}

function parseTokenTransfer(value: unknown, trackedAsset: TrackedErc20Asset): IndexedTokenTransfer {
  if (!isRecord(value)) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM token history transaction')
  }
  const contract = parseAddress(value.contractAddress, 'EVM token history contract')
  if (contract !== trackedAsset.contract) {
    throw new EvmRpcError('invalid-response', 'EVM token history returned another contract')
  }
  if (String(value.tokenDecimal) !== String(trackedAsset.decimals)) {
    throw new EvmRpcError('invalid-response', 'EVM token history decimals do not match')
  }
  return Object.freeze({
    transactionHash: parseHash(value.hash, 'EVM token history transaction hash'),
    ...(value.blockHash === ''
      ? {}
      : { blockHash: parseHash(value.blockHash, 'EVM token history block hash') }),
    blockHeight: parseSafeIntegerString(value.blockNumber, 'EVM token history block number'),
    confirmations: parseSafeIntegerString(value.confirmations, 'EVM token history confirmations'),
    from: parseAddress(value.from, 'EVM token history sender'),
    to: parseAddress(value.to, 'EVM token history recipient'),
    amountRaw: parseUnsignedDecimal(value.value, 'EVM token history amount'),
    ...(value.nonce === ''
      ? {}
      : { nonce: parseUnsignedDecimal(value.nonce, 'EVM token history nonce') }),
    timestamp: parseTimestamp(value.timeStamp),
    assetId: parseAssetId(trackedAsset.assetId).id
  })
}

interface ParsedEnvelope {
  readonly items: readonly unknown[]
  readonly partial: boolean
}

function parseEnvelope(value: unknown): ParsedEnvelope {
  if (!isRecord(value)) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history response envelope')
  }
  if (value.noirPartial !== undefined && value.noirPartial !== true) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history partial marker')
  }
  const partial = value.noirPartial === true
  if (
    value.status === '0' &&
    (value.message === 'No transactions found' || value.message === 'No token transfers found') &&
    Array.isArray(value.result) &&
    value.result.length === 0
  ) {
    return Object.freeze({ items: Object.freeze([]), partial })
  }
  if (value.message !== 'OK' || value.status !== '1') {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history response envelope')
  }
  if (!Array.isArray(value.result) || value.result.length > EVM_HISTORY_LIMIT) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM history result')
  }
  return Object.freeze({ items: Object.freeze(value.result), partial })
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new EvmRpcError('invalid-response', 'EVM history response exceeds the allowed size')
  )
}

function mapHttpError(status: number): EvmRpcError {
  if (status === 401 || status === 403) {
    return new EvmRpcError('unauthorized', 'EVM history authorization failed')
  }
  if (status === 429) return new EvmRpcError('rate-limited', 'EVM history rate limit exceeded')
  return new EvmRpcError('network-unavailable', 'EVM history endpoint is unavailable')
}

export function createEvmBlockscoutHistoryClient(
  config: EvmBlockscoutHistoryClientConfig,
  fetchImplementation: FetchImplementation = fetch
): EvmActivityHistorySource {
  const chain = parseChainId(config.chainId)
  if (chain.namespace !== 'eip155') throw new Error('EVM history requires an EVM chain ID')
  const apiUrl = parseApiUrl(config.apiUrl)
  const nativeAssetId = parseAssetId(config.nativeAssetId)
  if (nativeAssetId.chainId !== chain.id || nativeAssetId.namespace !== 'slip44') {
    throw new Error('EVM history native asset does not match its chain')
  }
  if (!Array.isArray(config.trackedErc20Assets) || config.trackedErc20Assets.length > 16) {
    throw new Error('Invalid EVM history token inventory')
  }
  if (typeof config.readFinalizedBlockNumber !== 'function') {
    throw new Error('Invalid EVM finalized block source')
  }
  const contracts = new Set<string>()
  const trackedAssets = Object.freeze(
    config.trackedErc20Assets.map(asset => {
      const assetId = parseAssetId(asset.assetId)
      const contract = parseAddress(asset.contract, 'EVM history token contract')
      if (
        assetId.chainId !== chain.id ||
        assetId.namespace !== 'erc20' ||
        assetId.reference !== contract ||
        !Number.isSafeInteger(asset.decimals) ||
        asset.decimals < 0 ||
        asset.decimals > 255 ||
        contracts.has(contract)
      ) {
        throw new Error('Invalid EVM history tracked token')
      }
      contracts.add(contract)
      return Object.freeze({ assetId: assetId.id, contract, decimals: asset.decimals })
    })
  )
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maximumResponseBytes = config.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error('Invalid EVM history timeout')
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1_024 ||
    maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new Error('Invalid EVM history response limit')
  }

  const request = async (
    action: 'txlist' | 'tokentx',
    addressValue: string,
    signal?: AbortSignal,
    contract?: string,
    fromBlock?: number
  ): Promise<ParsedEnvelope> => {
    if (signal?.aborted) throw new EvmRpcError('cancelled', 'EVM history request was cancelled')
    const address = parseAddress(addressValue, 'EVM history address')
    const url = new URL(apiUrl)
    url.searchParams.set('module', 'account')
    url.searchParams.set('action', action)
    url.searchParams.set('address', address)
    if (contract !== undefined) url.searchParams.set('contractaddress', contract)
    if (fromBlock !== undefined) {
      if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
        throw new Error('Invalid EVM history start block')
      }
      url.searchParams.set('startblock', String(fromBlock))
    }
    url.searchParams.set('page', '1')
    url.searchParams.set('offset', String(EVM_HISTORY_LIMIT))
    url.searchParams.set('sort', 'desc')

    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetchImplementation(url.toString(), {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw mapHttpError(response.status)
      const text = await readResponseText(response, maximumResponseBytes)
      let decoded: unknown
      try {
        decoded = JSON.parse(text)
      } catch {
        throw new EvmRpcError('invalid-response', 'EVM history response is not valid JSON')
      }
      return parseEnvelope(decoded)
    } catch (error) {
      if (error instanceof EvmRpcError) throw error
      if (controller.signal.aborted) {
        throw new EvmRpcError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'EVM history request timed out' : 'EVM history request was cancelled'
        )
      }
      throw new EvmRpcError('network-unavailable', 'EVM history request failed')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const readNormalTransactions = async (
    address: string,
    signal?: AbortSignal,
    fromBlock?: number
  ) => {
    const response = await request('txlist', address, signal, undefined, fromBlock)
    return Object.freeze({
      items: Object.freeze(response.items.map(parseNormalTransaction)),
      partial: response.partial
    })
  }

  return Object.freeze({
    readAddressActivity: async (input: ReadEvmAddressActivityInput) => {
      const address = parseAddress(input.address, 'EVM history address')
      const [normalResult, tokenResults] = await Promise.all([
        readNormalTransactions(address, input.signal, input.fromBlock).then(
          value => ({ status: 'fulfilled' as const, value }),
          reason => ({ status: 'rejected' as const, reason: reason as unknown })
        ),
        Promise.all(
          trackedAssets.map(async asset =>
            request('tokentx', address, input.signal, asset.contract, input.fromBlock).then(
              response =>
                ({
                  status: 'fulfilled' as const,
                  value: Object.freeze({
                    items: Object.freeze(
                      response.items.map(item => parseTokenTransfer(item, asset))
                    ),
                    partial: response.partial
                  })
                }) as const,
              reason => ({ status: 'rejected' as const, reason: reason as unknown })
            )
          )
        )
      ])
      const firstFailure =
        normalResult.status === 'rejected'
          ? normalResult.reason
          : tokenResults.find(result => result.status === 'rejected')?.reason
      const sourcePartial =
        firstFailure !== undefined ||
        (normalResult.status === 'fulfilled' && normalResult.value.partial) ||
        tokenResults.some(result => result.status === 'fulfilled' && result.value.partial)
      const normalTransactions =
        normalResult.status === 'fulfilled' ? normalResult.value.items : Object.freeze([])
      const tokenGroups = tokenResults.map(result =>
        result.status === 'fulfilled' ? result.value.items : Object.freeze([])
      )
      const tokenTransfers = tokenGroups.flat()
      const items = mapEvmIndexedActivity({
        request: input,
        chainId: chain.id,
        nativeAssetId: nativeAssetId.id,
        normalTransactions,
        tokenTransfers,
        sourcePartial
      })
      if (items.length === 0 && sourcePartial) {
        if (firstFailure !== undefined) throw firstFailure
        throw new EvmRpcError('invalid-response', 'EVM token history scan is incomplete')
      }
      return items
    },
    findConfirmedReplacement: async (input: FindEvmConfirmedReplacementInput) => {
      const sender = parseAddress(input.sender, 'EVM replacement sender')
      const nonce = parseUnsignedDecimal(input.nonce, 'EVM replacement nonce')
      const excluded = parseHash(input.excludedTransactionHash, 'EVM replacement transaction hash')
      const match = (await readNormalTransactions(sender, input.signal)).items.find(
        transaction =>
          transaction.from === sender &&
          transaction.nonce === nonce &&
          transaction.transactionHash !== excluded
      )
      return match
        ? Object.freeze({
            transactionHash: match.transactionHash,
            blockHash: match.blockHash,
            blockHeight: match.blockHeight,
            confirmedAt: match.timestamp
          })
        : null
    }
  })
}
