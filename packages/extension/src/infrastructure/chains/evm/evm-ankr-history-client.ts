import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import { getEvmAnkrHistoryBlockchain } from '@/config/networks'
import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseAssetId } from '@/core/chains/registry'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import {
  mapEvmIndexedActivity,
  EVM_ACTIVITY_ITEM_LIMIT,
  type EvmConfirmedReplacement,
  type FindEvmConfirmedReplacementInput,
  type IndexedTokenTransfer,
  type IndexedTransaction,
  type TrackedErc20Asset
} from './evm-indexed-activity'
import { EvmRpcError } from './evm-rpc-client'

const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024
const TX_PAGE_SIZE = 200
const TOKEN_PAGE_SIZE = 2_000
const UINT256_LIMIT = 1n << 256n
export interface EvmAnkrHistoryChain {
  readonly chainId: string
  readonly nativeAssetId: string
  readonly trackedErc20Assets: readonly TrackedErc20Asset[]
}

export interface EvmAnkrHistoryTarget {
  readonly chainId: string
  readonly scope: ActivityScope
  readonly address: string
  readonly fromBlock?: number
  readonly historyPageCount?: number
}

export type EvmAnkrHistoryResult =
  | {
      readonly items: readonly ActivityItem[]
      readonly partial: boolean
      readonly hasMore?: boolean
      readonly retrySingleChain?: boolean
    }
  | { readonly incomplete: true; readonly retrySingleChain: boolean }
  | { readonly error: unknown }

export interface EvmAnkrHistoryClient {
  readonly readAddressActivities: (
    targets: readonly EvmAnkrHistoryTarget[],
    signal?: AbortSignal
  ) => Promise<ReadonlyMap<string, EvmAnkrHistoryResult>>
  readonly findConfirmedReplacement: (
    chainId: string,
    input: FindEvmConfirmedReplacementInput
  ) => Promise<EvmConfirmedReplacement | null>
}

function invalid(label: string): never {
  throw new EvmRpcError('invalid-response', `Invalid Ankr ${label}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(label)
  return value as Record<string, unknown>
}

function address(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid(label)
  return value.toLowerCase()
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(label)
  return value.toLowerCase()
}

function quantity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) {
    invalid(label)
  }
  const parsed = BigInt(value)
  if (parsed >= UINT256_LIMIT) invalid(label)
  return parsed.toString(10)
}

function safeNumber(value: unknown, label: string): number {
  const parsed = Number(quantity(value, label))
  if (!Number.isSafeInteger(parsed)) invalid(label)
  return parsed
}

function tokenInteger(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) invalid(label)
  if (BigInt(value) >= UINT256_LIMIT) invalid(label)
  return value
}

function timestamp(value: number, label: string): number {
  const milliseconds = value * 1_000
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) invalid(label)
  return milliseconds
}

function parseTransaction(value: unknown): IndexedTransaction {
  const tx = record(value, 'transaction')
  if (tx.status !== '0x0' && tx.status !== '0x1') invalid('transaction status')
  if (typeof tx.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input)) {
    invalid('transaction input')
  }
  const recipient = tx.to === null || tx.to === '' ? undefined : address(tx.to, 'recipient')
  return Object.freeze({
    transactionHash: hash(tx.hash, 'transaction hash'),
    blockHash: hash(tx.blockHash, 'block hash'),
    blockHeight: safeNumber(tx.blockNumber, 'block number'),
    confirmations: 0,
    from: address(tx.from, 'sender'),
    ...(recipient ? { to: recipient } : {}),
    valueRaw: quantity(tx.value, 'transaction value'),
    gasPriceRaw: quantity(tx.gasPrice, 'gas price'),
    gasUsed: quantity(tx.gasUsed, 'gas used'),
    nonce: quantity(tx.nonce, 'nonce'),
    timestamp: timestamp(safeNumber(tx.timestamp, 'timestamp'), 'timestamp'),
    failed: tx.status === '0x0',
    input: tx.input.toLowerCase()
  })
}

function parseTransfer(
  value: unknown,
  assets: readonly TrackedErc20Asset[]
): IndexedTokenTransfer | null {
  const transfer = record(value, 'token transfer')
  const contract = address(transfer.contractAddress, 'token contract')
  const asset = assets.find(candidate => candidate.contract.toLowerCase() === contract)
  if (!asset) return null
  if (!Number.isSafeInteger(transfer.blockHeight) || (transfer.blockHeight as number) < 0) {
    invalid('token block height')
  }
  if (!Number.isSafeInteger(transfer.timestamp) || (transfer.timestamp as number) < 0) {
    invalid('token timestamp')
  }
  if (transfer.tokenDecimals !== asset.decimals) invalid('token decimals')
  const raw = transfer.valueRawInteger || transfer.value
  return Object.freeze({
    transactionHash: hash(transfer.transactionHash, 'token transaction hash'),
    blockHeight: transfer.blockHeight as number,
    confirmations: 0,
    from: address(transfer.fromAddress, 'token sender'),
    to: address(transfer.toAddress, 'token recipient'),
    amountRaw: tokenInteger(raw, 'token amount'),
    timestamp: timestamp(transfer.timestamp as number, 'token timestamp'),
    assetId: parseAssetId(asset.assetId).id
  })
}

function parsePage(
  value: unknown,
  field: 'transactions' | 'transfers',
  limit: number
): {
  readonly items: readonly unknown[]
  readonly partial: boolean
  readonly nextPageToken?: string
} {
  const result = record(value, 'result')
  if (!Array.isArray(result[field]) || result[field].length > limit) invalid(field)
  const next = result.nextPageToken
  if (next !== undefined && (typeof next !== 'string' || next.length === 0 || next.length > 512)) {
    invalid('page token')
  }
  return Object.freeze({
    items: result[field] as unknown[],
    partial: !!next,
    ...(next ? { nextPageToken: next as string } : {})
  })
}

function parseOrigin(value: string): string {
  const url = new URL(value)
  const localDevelopment =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if (
    (url.protocol !== 'https:' && !localDevelopment) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('EVM history origin must be credential-free HTTPS')
  }
  return url.toString()
}

export function createEvmAnkrHistoryClient(
  originValue: string,
  chains: readonly EvmAnkrHistoryChain[],
  fetchImplementation: typeof fetch = fetch
): EvmAnkrHistoryClient {
  const origin = parseOrigin(originValue)
  const byChainId = new Map(chains.map(chain => [chain.chainId, chain] as const))
  if (
    byChainId.size !== chains.length ||
    chains.some(chain => !getEvmAnkrHistoryBlockchain(chain.chainId))
  ) {
    throw new Error('Invalid Ankr history chain inventory')
  }

  async function request(
    method: 'ankr_getTransactionsByAddress' | 'ankr_getTokenTransfers',
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, DEFAULT_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImplementation(origin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) {
        if (response.status === 429)
          throw new EvmRpcError('rate-limited', 'EVM history rate limit exceeded')
        throw new EvmRpcError('network-unavailable', 'EVM history endpoint is unavailable')
      }
      const body = await readBoundedResponseText(
        response,
        MAXIMUM_RESPONSE_BYTES,
        () => new EvmRpcError('invalid-response', 'EVM history response is too large')
      )
      let decoded: unknown
      try {
        decoded = JSON.parse(body)
      } catch {
        invalid('JSON response')
      }
      const envelope = record(decoded, 'JSON-RPC response')
      if (envelope.jsonrpc !== '2.0' || envelope.id !== 1) invalid('JSON-RPC response')
      if ('error' in envelope) {
        const error = record(envelope.error, 'JSON-RPC error')
        if (!Number.isSafeInteger(error.code)) invalid('JSON-RPC error code')
        if (error.code === -32000) {
          throw new EvmRpcError('network-unavailable', 'EVM history upstream is unavailable')
        }
        throw new EvmRpcError('invalid-response', 'EVM history upstream rejected the request')
      }
      if (!('result' in envelope)) invalid('JSON-RPC result')
      return envelope.result
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
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async function readAddressActivities(
    targets: readonly EvmAnkrHistoryTarget[],
    signal?: AbortSignal
  ): Promise<ReadonlyMap<string, EvmAnkrHistoryResult>> {
    if (targets.length === 0) return new Map()
    const requested = new Map(targets.map(target => [target.chainId, target] as const))
    if (requested.size !== targets.length || targets.length > 16)
      throw new Error('Invalid Ankr history batch')
    const firstAddress = address(targets[0].address, 'wallet address')
    const historyPageCount = targets[0].historyPageCount ?? 1
    if (
      !Number.isSafeInteger(historyPageCount) ||
      historyPageCount < 1 ||
      historyPageCount > 10 ||
      (historyPageCount > 1 && targets.length !== 1)
    ) {
      throw new Error('Invalid Ankr history page count')
    }
    for (const target of targets) {
      if (
        !byChainId.has(target.chainId) ||
        address(target.address, 'wallet address') !== firstAddress
      ) {
        throw new Error('Ankr history batch must share one address and configured chains')
      }
      if (
        target.fromBlock !== undefined &&
        (!Number.isSafeInteger(target.fromBlock) || target.fromBlock < 0)
      ) {
        throw new Error('Invalid Ankr history start block')
      }
      if ((target.historyPageCount ?? 1) !== historyPageCount) {
        throw new Error('Ankr history batch must share one page count')
      }
    }
    const blockchains = targets.map(target => getEvmAnkrHistoryBlockchain(target.chainId)!)
    const fromBlock = targets.every(target => target.fromBlock !== undefined)
      ? Math.min(...targets.map(target => target.fromBlock as number))
      : undefined
    const common = {
      blockchain: blockchains,
      descOrder: true,
      ...(fromBlock === undefined ? {} : { fromBlock })
    }
    async function readPages(
      method: 'ankr_getTransactionsByAddress' | 'ankr_getTokenTransfers',
      field: 'transactions' | 'transfers',
      pageSize: number,
      requestedAddress: string | string[]
    ): Promise<{
      readonly items: readonly unknown[]
      readonly partial: boolean
      readonly failed: boolean
    }> {
      const items: unknown[] = []
      const seenTokens = new Set<string>()
      let pageToken: string | undefined
      for (let page = 0; page < historyPageCount; page++) {
        let result: ReturnType<typeof parsePage>
        try {
          result = parsePage(
            await request(
              method,
              {
                ...common,
                address: requestedAddress,
                pageSize,
                ...(pageToken ? { pageToken } : {})
              },
              signal
            ),
            field,
            pageSize
          )
        } catch (error) {
          if (page === 0) throw error
          return { items, partial: true, failed: true }
        }
        items.push(...result.items)
        pageToken = result.nextPageToken
        if (!pageToken) return { items, partial: false, failed: false }
        if (seenTokens.has(pageToken)) {
          throw new EvmRpcError('invalid-response', 'Ankr history repeated a page token')
        }
        seenTokens.add(pageToken)
      }
      return { items, partial: true, failed: false }
    }
    const [native, tokens] = await Promise.allSettled([
      readPages('ankr_getTransactionsByAddress', 'transactions', TX_PAGE_SIZE, firstAddress),
      readPages('ankr_getTokenTransfers', 'transfers', TOKEN_PAGE_SIZE, [firstAddress])
    ])
    const output = new Map<string, EvmAnkrHistoryResult>()
    if (signal?.aborted) {
      for (const target of targets) {
        output.set(target.chainId, {
          error: new EvmRpcError('cancelled', 'EVM history request was cancelled')
        })
      }
      return output
    }
    if (native.status === 'rejected' && tokens.status === 'rejected') {
      for (const target of targets) output.set(target.chainId, { error: native.reason })
      return output
    }
    if (historyPageCount > 1) {
      const failure =
        native.status === 'rejected'
          ? native.reason
          : tokens.status === 'rejected'
            ? tokens.reason
            : native.value.failed || tokens.value.failed
              ? new EvmRpcError('network-unavailable', 'EVM history page is unavailable')
              : null
      if (failure) {
        output.set(targets[0].chainId, { error: failure })
        return output
      }
    }
    const expected = new Set(blockchains)
    for (const page of [native, tokens]) {
      if (page.status !== 'fulfilled') continue
      if (
        page.value.items.some(
          item => !expected.has(record(item, 'history item').blockchain as string)
        )
      ) {
        for (const target of targets)
          output.set(target.chainId, {
            error: new EvmRpcError('invalid-response', 'Ankr returned another blockchain')
          })
        return output
      }
    }
    const branchFailed =
      native.status === 'rejected' ||
      tokens.status === 'rejected' ||
      (native.status === 'fulfilled' && native.value.failed) ||
      (tokens.status === 'fulfilled' && tokens.value.failed)
    const pageTruncated =
      (native.status === 'fulfilled' && native.value.partial) ||
      (tokens.status === 'fulfilled' && tokens.value.partial)
    const retrySharedFailure =
      targets.length > 1 &&
      [native, tokens].some(
        branch =>
          branch.status === 'rejected' &&
          branch.reason instanceof EvmRpcError &&
          (branch.reason.code === 'network-unavailable' || branch.reason.code === 'timeout')
      )
    const partial = branchFailed || pageTruncated
    for (const target of targets) {
      const chain = byChainId.get(target.chainId)!
      const blockchain = getEvmAnkrHistoryBlockchain(target.chainId)!
      try {
        const normalTransactions =
          native.status === 'fulfilled'
            ? native.value.items
                .filter(item => record(item, 'transaction').blockchain === blockchain)
                .map(parseTransaction)
            : []
        const tokenTransfers =
          tokens.status === 'fulfilled'
            ? tokens.value.items
                .filter(item => record(item, 'token transfer').blockchain === blockchain)
                .map(item => parseTransfer(item, chain.trackedErc20Assets))
                .filter((item): item is IndexedTokenTransfer => item !== null)
            : []
        const items = mapEvmIndexedActivity({
          request: target,
          chainId: target.chainId,
          nativeAssetId: chain.nativeAssetId,
          normalTransactions,
          tokenTransfers,
          sourcePartial: partial,
          itemLimit: historyPageCount > 1 ? EVM_ACTIVITY_ITEM_LIMIT : undefined
        })
        if (items.length === 0 && partial) {
          output.set(target.chainId, {
            incomplete: true,
            retrySingleChain: (pageTruncated && !branchFailed) || retrySharedFailure
          })
        } else {
          output.set(target.chainId, {
            items,
            partial,
            retrySingleChain: retrySharedFailure,
            hasMore:
              historyPageCount > 1 && items.length >= EVM_ACTIVITY_ITEM_LIMIT
                ? false
                : pageTruncated || branchFailed || items.length >= 200
          })
        }
      } catch (error) {
        output.set(target.chainId, { error })
      }
    }
    return output
  }

  async function findConfirmedReplacement(
    chainId: string,
    input: FindEvmConfirmedReplacementInput
  ): Promise<EvmConfirmedReplacement | null> {
    const blockchain = getEvmAnkrHistoryBlockchain(chainId)
    if (!byChainId.has(chainId) || !blockchain) throw new Error('Unsupported Ankr history chain')
    const sender = address(input.sender, 'replacement sender')
    const excluded = hash(input.excludedTransactionHash, 'replacement transaction hash')
    const nonce = tokenInteger(input.nonce, 'replacement nonce')
    const page = parsePage(
      await request(
        'ankr_getTransactionsByAddress',
        {
          blockchain: [blockchain],
          address: sender,
          pageSize: TX_PAGE_SIZE,
          descOrder: true
        },
        input.signal
      ),
      'transactions',
      TX_PAGE_SIZE
    )
    for (const item of page.items) {
      const raw = record(item, 'replacement transaction')
      if (raw.blockchain !== blockchain) invalid('replacement blockchain')
      const tx = parseTransaction(raw)
      if (tx.from === sender && tx.nonce === nonce && tx.transactionHash !== excluded) {
        return Object.freeze({
          transactionHash: tx.transactionHash,
          blockHash: tx.blockHash,
          blockHeight: tx.blockHeight,
          confirmedAt: tx.timestamp
        })
      }
    }
    return null
  }

  return Object.freeze({ readAddressActivities, findConfirmedReplacement })
}
