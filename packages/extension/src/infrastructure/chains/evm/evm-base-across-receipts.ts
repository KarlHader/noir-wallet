import { DedupPromise } from '@/lib/async-utils'
import type { ActivityItem } from '@/core/activity'
import { parseAssetId } from '@/core/chains/registry'
import {
  indexedDbBaseAcrossHistoryCache,
  type EvmHistoryCacheRepository
} from './evm-activity-history-cache'
import { mapEvmIndexedActivity, type ReadEvmAddressActivityInput } from './evm-indexed-activity'
import type { EvmDAppReadRpc } from './evm-rpc-client'

const SPOKE_POOL = '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64'
const WETH = '0x4200000000000000000000000000000000000006'
const FILLED_RELAY = '0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208'
const FILLED_V3_RELAY = '0x571749edf1d5c9599318cdbc4e28a6475d65e87fd3b2ddbe1e9a8d5e7a0f0ff7'
const WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const POOL_TOPIC = `0x${SPOKE_POOL.slice(2).padStart(64, '0')}`
const FILL_TOPICS = new Set([FILLED_RELAY, FILLED_V3_RELAY])
export const BASE_ACROSS_CHAIN_ID = 'eip155:8453'
const START_BLOCK = 61_274_000
const SCAN_SIZE = 5_000
const MAX_TRANSACTIONS = 12
const RETRY_MS = 60_000

type RpcRecord = Record<string, unknown>
type BaseRpc = (
  method: 'eth_getLogs' | 'eth_getTransactionReceipt' | 'eth_getBlockByHash',
  params: unknown[]
) => Promise<unknown>

interface Cursor {
  readonly block: number
  readonly logIndex: number
}

interface RelayLog {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly logIndex: number
  readonly address: string
  readonly topics: string[]
  readonly data: string
}

interface ReceiptRow {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly logIndex: number
  readonly from: string
  readonly to: string
  readonly amountRaw: string
  readonly timestamp: number
}

function invalid(): never {
  throw new Error('Invalid Base receipt RPC data')
}

function record(value: unknown): RpcRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as RpcRecord
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid()
  return value
}

function hex(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid()
  return value.toLowerCase()
}

function hash(value: unknown): string {
  return hex(value, /^0x[\da-f]{64}$/i)
}

function quantity(value: unknown): bigint {
  return BigInt(hex(value, /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i))
}

function number(value: unknown): number {
  const parsed = Number(quantity(value))
  if (!Number.isSafeInteger(parsed)) invalid()
  return parsed
}

function readLog(value: unknown) {
  const log = record(value)
  return {
    address: hex(log.address, /^0x[\da-f]{40}$/i),
    topics: list(log.topics).map(hash),
    data: hex(log.data, /^0x(?:[\da-f]{2})*$/i)
  }
}

function readRelayLog(value: unknown): RelayLog {
  const raw = record(value)
  const log = readLog(raw)
  if (raw.removed === true || log.address !== SPOKE_POOL || !FILL_TOPICS.has(log.topics[0])) {
    invalid()
  }
  return {
    ...log,
    transactionHash: hash(raw.transactionHash),
    blockHash: hash(raw.blockHash),
    blockHeight: number(raw.blockNumber),
    logIndex: number(raw.logIndex)
  }
}

function relayPayout(log: ReturnType<typeof readLog>) {
  const data = log.data.slice(2)
  const word = (index: number) => {
    const value = data.slice(index * 64, (index + 1) * 64)
    if (value.length !== 64) invalid()
    return value
  }
  if (word(1) !== WETH.slice(2).padStart(64, '0')) return null
  let recipientIndex = 11
  if (log.topics[0] === FILLED_V3_RELAY) {
    const offset = Number(BigInt(`0x${word(10)}`))
    if (!Number.isSafeInteger(offset) || offset < 352 || offset % 32 !== 0) invalid()
    recipientIndex = offset / 32
  }
  const recipient = word(recipientIndex)
  const amount = BigInt(`0x${word(recipientIndex + 2)}`)
  if (!/^0{24}[\da-f]{40}$/.test(recipient) || amount === 0n) return null
  return { to: `0x${recipient.slice(24)}`, amount }
}

function logKey(log: ReturnType<typeof readLog>): string {
  return `${log.address}:${log.topics.join(':')}:${log.data}`
}

function receiptPayouts(receiptLogs: unknown[]) {
  const fills = new Map<number, { log: RelayLog; native: boolean }>()
  let pending:
    | { fill: { log: RelayLog; native: boolean }; amount: bigint; funded: boolean }
    | undefined
  for (const raw of receiptLogs) {
    const log = readLog(raw)
    if (log.address === SPOKE_POOL && FILL_TOPICS.has(log.topics[0])) {
      const fill = { log: readRelayLog(raw), native: false }
      if (fills.has(fill.log.logIndex)) invalid()
      fills.set(fill.log.logIndex, fill)
      const payout = relayPayout(fill.log)
      pending = payout ? { fill, amount: payout.amount, funded: false } : undefined
      continue
    }
    if (!pending) continue
    const matchingWeth =
      log.address === WETH &&
      /^0x[\da-f]{64}$/.test(log.data) &&
      BigInt(log.data) === pending.amount
    if (
      matchingWeth &&
      !pending.funded &&
      log.topics.length === 3 &&
      log.topics[0] === TRANSFER &&
      log.topics[2] === POOL_TOPIC
    ) {
      pending.funded = true
      continue
    }
    pending.fill.native =
      matchingWeth &&
      log.topics.length === 2 &&
      log.topics[0] === WITHDRAWAL &&
      log.topics[1] === POOL_TOPIC
    pending = undefined
  }
  return fills
}

export async function scanBaseAcrossReceipts(
  cursor: Cursor,
  finalized: number,
  recipient: string,
  rpc: BaseRpc
) {
  const end = Math.min(finalized, cursor.block + SCAN_SIZE - 1)
  if (end < cursor.block) return { cursor, rows: [] }
  const toHex = (value: number) => `0x${value.toString(16)}`
  const logs = list(
    await rpc('eth_getLogs', [
      {
        address: SPOKE_POOL,
        topics: [[...FILL_TOPICS]],
        fromBlock: toHex(cursor.block),
        toBlock: toHex(end)
      }
    ])
  )
    .map(readRelayLog)
    .sort((left, right) => left.blockHeight - right.blockHeight || left.logIndex - right.logIndex)
  const pending = new Map<string, RelayLog[]>()
  const seen = new Set<string>()
  let next = { block: end + 1, logIndex: -1 }
  for (const log of logs) {
    if (log.blockHeight < cursor.block || log.blockHeight > end) invalid()
    if (log.blockHeight === cursor.block && log.logIndex <= cursor.logIndex) continue
    const id = `${log.blockHeight}:${log.logIndex}`
    if (seen.has(id)) invalid()
    seen.add(id)
    if (relayPayout(log)?.to !== recipient) continue
    let group = pending.get(log.transactionHash)
    if (!group) {
      if (pending.size === MAX_TRANSACTIONS) {
        next = { block: log.blockHeight, logIndex: log.logIndex - 1 }
        break
      }
      group = []
      pending.set(log.transactionHash, group)
    }
    group.push(log)
  }
  const rows: ReceiptRow[] = []
  const timestamps = new Map<string, number>()
  for (const [transactionHash, candidates] of pending) {
    const receipt = record(await rpc('eth_getTransactionReceipt', [transactionHash]))
    const { blockHash, blockHeight } = candidates[0]
    if (
      receipt.status !== '0x1' ||
      hash(receipt.transactionHash) !== transactionHash ||
      hash(receipt.blockHash) !== blockHash ||
      number(receipt.blockNumber) !== blockHeight
    )
      invalid()
    const receiptFills = receiptPayouts(list(receipt.logs))
    for (const candidate of candidates) {
      const fill = receiptFills.get(candidate.logIndex)
      const log = fill?.log
      if (
        !log ||
        logKey(log) !== logKey(candidate) ||
        log.blockHash !== candidate.blockHash ||
        log.transactionHash !== transactionHash ||
        log.blockHeight !== candidate.blockHeight
      )
        invalid()
      if (!fill.native) continue
      const payout = relayPayout(log)
      if (!payout) invalid()
      let timestamp = timestamps.get(blockHash)
      if (timestamp === undefined) {
        const block = record(await rpc('eth_getBlockByHash', [blockHash, false]))
        if (hash(block.hash) !== blockHash || number(block.number) !== blockHeight) invalid()
        timestamp = number(block.timestamp) * 1_000
        if (!Number.isSafeInteger(timestamp)) invalid()
        timestamps.set(blockHash, timestamp)
      }
      rows.push({
        transactionHash,
        blockHash,
        blockHeight,
        logIndex: log.logIndex,
        from: SPOKE_POOL,
        to: payout.to,
        amountRaw: payout.amount.toString(),
        timestamp
      })
    }
  }
  return { cursor: next, rows }
}

export function createBaseAcrossReceiptHistory(input: {
  readonly nativeAssetId: string
  readonly rpc: EvmDAppReadRpc
  readonly cache?: EvmHistoryCacheRepository
}) {
  const cache = input.cache ?? indexedDbBaseAcrossHistoryCache
  const assetId = parseAssetId(input.nativeAssetId).id
  const inFlight = new Map<string, DedupPromise<readonly ActivityItem[]>>()

  return async (request: ReadEvmAddressActivityInput): Promise<readonly ActivityItem[]> => {
    const { scope } = request
    const address = hex(request.address, /^0x[\da-f]{40}$/i)
    const key = JSON.stringify([scope.keyDomainId, scope.accountId, address])
    const refresh = inFlight.get(key) ?? new DedupPromise<readonly ActivityItem[]>()
    inFlight.set(key, refresh)
    try {
      return await refresh.run(async () => {
        const cached = await cache.read(BASE_ACROSS_CHAIN_ID, address, scope)
        const now = Date.now()
        if (cached && cached.retryAfter > now) return cached.items
        const cursor = cached?.baseAcrossCursor ?? { block: START_BLOCK, logIndex: -1 }
        const timeout = AbortSignal.timeout(8_000)
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
        const rpc: BaseRpc = (method, params) => input.rpc.requestDAppRead(method, params, signal)
        let next = cursor
        let rows: ReceiptRow[] = []
        let successfulSyncAt = cached?.successfulSyncAt ?? null
        try {
          const block = await input.rpc.requestDAppRead(
            'eth_getBlockByNumber',
            ['finalized', false],
            signal
          )
          const finalized = number(record(block).number)
          const latestStart = Math.max(START_BLOCK, finalized - SCAN_SIZE + 1)
          const results = await Promise.allSettled([
            scanBaseAcrossReceipts(cursor, finalized, address, rpc),
            ...(latestStart >= cursor.block + SCAN_SIZE
              ? [
                  scanBaseAcrossReceipts(
                    { block: latestStart, logIndex: -1 },
                    finalized,
                    address,
                    rpc
                  )
                ]
              : [])
          ])
          const [backfill] = results
          if (backfill.status === 'fulfilled') next = backfill.value.cursor
          rows = results.flatMap(result => (result.status === 'fulfilled' ? result.value.rows : []))
          if (results.some(result => result.status === 'fulfilled')) successfulSyncAt = now
        } catch {
          if (request.signal?.aborted) return cached?.items ?? []
        }
        if (request.signal?.aborted) return cached?.items ?? []
        const items = mapEvmIndexedActivity({
          request,
          chainId: BASE_ACROSS_CHAIN_ID,
          nativeAssetId: assetId,
          normalTransactions: [],
          tokenTransfers: [],
          indexedNativeReceipts: rows.map(row => ({ ...row, assetId, confirmations: 1 })),
          sourcePartial: false
        })
        await cache
          .write({
            schemaVersion: 1,
            chainId: BASE_ACROSS_CHAIN_ID,
            scope,
            address,
            lastAttemptAt: now,
            successfulSyncAt,
            retryAfter: now + RETRY_MS,
            baseAcrossCursor: next,
            items
          })
          .catch(() => undefined)
        return [
          ...new Map([...(cached?.items ?? []), ...items].map(item => [item.id, item])).values()
        ]
      })
    } finally {
      if (inFlight.get(key) === refresh && !refresh.isPending) inFlight.delete(key)
    }
  }
}
