import type { ActivityItem, ActivityScope } from '@/core/activity'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import { parseAssetId, parseChainId } from '@/core/chains/registry'

import type { StarknetPendingTransfer } from './starknet-pending-transfer-store'
import {
  dedupStarknetActivityEvents,
  feltToBigint,
  mergeStarknetU256,
  STARKNET_TRANSFER_EVENT_SELECTOR,
  starknetActivityDedupKey
} from './starknet-primitives'
import { StarknetRpcError, type StarknetReadRpc, type StarknetRpcEvent } from './starknet-rpc-types'

export class StarknetActivityScanError extends Error {
  readonly items: readonly ActivityItem[]

  constructor(items: readonly ActivityItem[]) {
    super('Starknet activity scan did not finish')
    this.name = 'StarknetActivityScanError'
    this.items = items
  }
}

export interface StarknetStoredTransfer {
  readonly txHash: string
  readonly eventIndex: string
  readonly assetId: string
  readonly from: string
  readonly to: string
  readonly amount: string
  readonly blockNumber: number
  readonly timestampMs: number
}

export interface StarknetActivityCursor {
  readonly blockNumber: number
  readonly transfers?: readonly StarknetStoredTransfer[]
}

export interface StarknetActivityCursorStore {
  get(key: string): Promise<StarknetActivityCursor | null>
  set(key: string, cursor: StarknetActivityCursor): Promise<void>
}

export interface StarknetActivityHistorySource {
  readAddressActivity(input: {
    readonly scope: ActivityScope
    readonly address: string
    readonly localPending?: readonly StarknetPendingTransfer[]
    readonly signal?: AbortSignal
  }): Promise<readonly ActivityItem[]>
}

const CHUNK_SIZE = 100
const MAX_PAGES = 20

export function createStarknetActivityHistorySource(config: {
  readonly chainId: string
  readonly tokens: readonly { readonly reference: string; readonly assetId: string }[]
  readonly rpc: Pick<StarknetReadRpc, 'getEvents' | 'getBlockTimestamp'>
  readonly cursors: StarknetActivityCursorStore
}): StarknetActivityHistorySource {
  const chainId = parseChainId(config.chainId).id
  if (parseChainId(config.chainId).namespace !== 'starknet') {
    throw new Error('Starknet activity requires a Starknet chain')
  }
  const allowedAssets = new Set(config.tokens.map(token => token.assetId))
  const blockTimestamps = new Map<number, number>()
  return {
    async readAddressActivity(input) {
      const account = normalizeStarknetFelt(input.address)
      const cursorKey = `starknet_activity_cursor:${chainId}:${account}`
      const cursor = await config.cursors.get(cursorKey)
      const fromBlock = { block_number: cursor?.blockNumber ?? 0 }
      const collected = new Map<string, ParsedTransfer>()
      for (const stored of cursor?.transfers ?? []) {
        if (!allowedAssets.has(stored.assetId)) continue
        const restored = restoreStoredTransfer(stored, account, chainId)
        if (restored) collected.set(starknetActivityDedupKey(restored), restored)
      }
      let complete = true
      let maxBlock = cursor?.blockNumber ?? 0
      const timestampFor = async (blockNumber: number): Promise<number> => {
        const cached = blockTimestamps.get(blockNumber)
        if (cached !== undefined) return cached
        const seconds = await config.rpc.getBlockTimestamp(blockNumber, input.signal)
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 10_000_000_000) {
          throw new Error('Starknet block timestamp is invalid')
        }
        const timestampMs = seconds * 1000
        blockTimestamps.set(blockNumber, timestampMs)
        return timestampMs
      }
      try {
        for (const token of config.tokens) {
          const fromEvents = await readDirection(
            config.rpc,
            token.reference,
            fromBlock,
            [[STARKNET_TRANSFER_EVENT_SELECTOR], [account]],
            input.signal
          )
          const toEvents = await readDirection(
            config.rpc,
            token.reference,
            fromBlock,
            [[STARKNET_TRANSFER_EVENT_SELECTOR], [], [account]],
            input.signal
          )
          if (!fromEvents.complete || !toEvents.complete) complete = false
          maxBlock = Math.max(maxBlock, fromEvents.maxBlock, toEvents.maxBlock)
          for (const event of [...fromEvents.events, ...toEvents.events]) {
            const parsed = parseTransferEvent(event, account, token.assetId, chainId)
            if (!parsed) continue
            const timestampMs = await timestampFor(parsed.blockNumber)
            const stamped = { ...parsed, timestampMs }
            collected.set(starknetActivityDedupKey(stamped), stamped)
          }
        }
      } catch (error) {
        const partial = toItems(
          [...collected.values()],
          input.scope,
          account,
          chainId,
          input.localPending,
          'partial'
        )
        if (partial.length === 0) throw error
        throw new StarknetActivityScanError(partial)
      }
      const events = [...collected.values()]
      if (!complete && events.length === 0) {
        throw new StarknetActivityScanError(
          toItems([], input.scope, account, chainId, input.localPending, 'partial')
        )
      }
      if (complete) {
        await config.cursors.set(cursorKey, {
          blockNumber: maxBlock,
          transfers: events.map(storeTransfer)
        })
      }
      return toItems(
        events,
        input.scope,
        account,
        chainId,
        input.localPending,
        complete ? 'complete' : 'partial'
      )
    }
  }
}

interface ParsedTransfer {
  readonly chainId: string
  readonly account: string
  readonly txHash: string
  readonly eventIndex: string
  readonly assetId: string
  readonly from: string
  readonly to: string
  readonly amount: bigint
  readonly blockNumber: number
  readonly timestampMs: number
}

async function readDirection(
  rpc: Pick<StarknetReadRpc, 'getEvents'>,
  address: string,
  fromBlock: string | { readonly block_number: number },
  keys: readonly (readonly string[])[],
  signal?: AbortSignal
): Promise<{
  readonly events: readonly StarknetRpcEvent[]
  readonly complete: boolean
  readonly maxBlock: number
}> {
  const events: StarknetRpcEvent[] = []
  let continuationToken: string | undefined
  let maxBlock = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result
    try {
      result = await rpc.getEvents(
        {
          fromBlock,
          toBlock: 'pre_confirmed',
          address: normalizeStarknetFelt(address),
          keys,
          chunkSize: CHUNK_SIZE,
          ...(continuationToken === undefined ? {} : { continuationToken })
        },
        signal
      )
    } catch (error) {
      if (events.length === 0 && error instanceof StarknetRpcError) throw error
      return { events, complete: false, maxBlock }
    }
    events.push(...result.events)
    for (const event of result.events) maxBlock = Math.max(maxBlock, event.blockNumber)
    if (!result.continuationToken) return { events, complete: true, maxBlock }
    continuationToken = result.continuationToken
  }
  return { events, complete: false, maxBlock }
}

export function parseTransferEvent(
  event: StarknetRpcEvent,
  account: string,
  assetId: string,
  chainId: string
): ParsedTransfer | null {
  const selector = normalizeStarknetFelt(event.keys[0] ?? '')
  if (selector !== normalizeStarknetFelt(STARKNET_TRANSFER_EVENT_SELECTOR)) return null
  let from: string
  let to: string
  let low: string
  let high: string
  if (event.keys.length === 1) {
    if (event.data.length < 4) return null
    from = event.data[0] ?? ''
    to = event.data[1] ?? ''
    low = event.data[2] ?? ''
    high = event.data[3] ?? ''
  } else if (event.keys.length >= 3) {
    from = event.keys[1] ?? ''
    to = event.keys[2] ?? ''
    if (event.data.length < 2) return null
    low = event.data[0] ?? ''
    high = event.data[1] ?? ''
  } else {
    return null
  }
  try {
    const fromAddress = readEventFelt(from)
    const toAddress = readEventFelt(to)
    if (fromAddress !== account && toAddress !== account) return null
    return {
      chainId,
      account,
      txHash: normalizeStarknetFelt(event.transactionHash),
      eventIndex: event.eventIndex,
      assetId,
      from: fromAddress,
      to: toAddress,
      amount: mergeStarknetU256(
        feltToBigint(readEventFelt(low)),
        feltToBigint(readEventFelt(high))
      ),
      blockNumber: event.blockNumber,
      timestampMs: 0
    }
  } catch {
    return null
  }
}

export function parseStarknetActivityCursor(value: unknown): StarknetActivityCursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const blockNumber = Reflect.get(value, 'blockNumber')
  if (typeof blockNumber !== 'number' || !Number.isInteger(blockNumber) || blockNumber < 0)
    return null
  const raw = Reflect.get(value, 'transfers')
  if (raw === undefined) return { blockNumber }
  if (!Array.isArray(raw)) return { blockNumber }
  const transfers: StarknetStoredTransfer[] = []
  for (const item of raw) {
    const parsed = parseStoredTransfer(item)
    if (parsed) transfers.push(parsed)
  }
  return { blockNumber, transfers }
}

function parseStoredTransfer(value: unknown): StarknetStoredTransfer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const txHash = Reflect.get(value, 'txHash')
  const eventIndex = Reflect.get(value, 'eventIndex')
  const assetId = Reflect.get(value, 'assetId')
  const from = Reflect.get(value, 'from')
  const to = Reflect.get(value, 'to')
  const amount = Reflect.get(value, 'amount')
  const blockNumber = Reflect.get(value, 'blockNumber')
  const timestampMs = Reflect.get(value, 'timestampMs')
  if (
    typeof txHash !== 'string' ||
    typeof eventIndex !== 'string' ||
    typeof assetId !== 'string' ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof amount !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(amount) ||
    typeof blockNumber !== 'number' ||
    !Number.isInteger(blockNumber) ||
    blockNumber < 0 ||
    typeof timestampMs !== 'number' ||
    !Number.isInteger(timestampMs) ||
    timestampMs < 1_000_000_000_000 ||
    timestampMs === blockNumber
  ) {
    return null
  }
  return { txHash, eventIndex, assetId, from, to, amount, blockNumber, timestampMs }
}

function storeTransfer(event: ParsedTransfer): StarknetStoredTransfer {
  return {
    txHash: event.txHash,
    eventIndex: event.eventIndex,
    assetId: event.assetId,
    from: event.from,
    to: event.to,
    amount: event.amount.toString(),
    blockNumber: event.blockNumber,
    timestampMs: event.timestampMs
  }
}

function restoreStoredTransfer(
  stored: StarknetStoredTransfer,
  account: string,
  chainId: string
): ParsedTransfer | null {
  const parsed = parseStoredTransfer(stored)
  if (!parsed) return null
  return {
    chainId,
    account,
    txHash: parsed.txHash,
    eventIndex: parsed.eventIndex,
    assetId: parsed.assetId,
    from: parsed.from,
    to: parsed.to,
    amount: BigInt(parsed.amount),
    blockNumber: parsed.blockNumber,
    timestampMs: parsed.timestampMs
  }
}

function canonicalStarknetFelt(value: string): string | null {
  try {
    return normalizeStarknetFelt(value)
  } catch {
    return null
  }
}

function readEventFelt(value: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('Invalid Starknet event felt')
  const body = value.slice(2).replace(/^0+/, '')
  return `0x${body.length === 0 ? '0' : body.toLowerCase()}`
}

function toItems(
  events: readonly ParsedTransfer[],
  scope: ActivityScope,
  account: string,
  chainId: string,
  localPending: readonly StarknetPendingTransfer[] | undefined,
  completeness: 'complete' | 'partial'
): readonly ActivityItem[] {
  const unique = dedupStarknetActivityEvents(events)
  const seen = new Set(unique.map(event => starknetActivityDedupKey(event)))
  const items = unique.map(event => eventItem(event, scope, account, completeness))
  for (const pending of localPending ?? []) {
    const sender = canonicalStarknetFelt(pending.sender)
    const recipient = canonicalStarknetFelt(pending.recipient)
    if (sender !== account && recipient !== account) continue
    const hash = pending.invokeHash ?? pending.deployHash
    const key = hash
      ? starknetActivityDedupKey({
          chainId,
          account,
          txHash: normalizeStarknetFelt(hash),
          eventIndex: 'pending'
        })
      : `pending:${pending.transactionId}`
    if (hash && unique.some(event => event.txHash === normalizeStarknetFelt(hash))) continue
    if (seen.has(key)) continue
    seen.add(key)
    items.push(pendingItem(pending, scope, account, chainId))
  }
  if (!completeness && items.length === 0) return Object.freeze([])
  return Object.freeze(items)
}

function eventItem(
  event: ParsedTransfer,
  scope: ActivityScope,
  account: string,
  completeness: 'complete' | 'partial'
): ActivityItem {
  const chain = parseChainId(event.chainId).id
  const assetId = parseAssetId(event.assetId).id
  const direction =
    event.from === account ? (event.to === account ? 'self' : 'outgoing') : 'incoming'
  const id = `rpc:starknet:${event.txHash}:${event.eventIndex}`
  return {
    id,
    source: 'rpc',
    scope,
    kind: 'transfer',
    status: 'final',
    snapshot: {
      schemaVersion: 1,
      direction,
      primaryAmount: { assetId, amountRaw: event.amount.toString() },
      sender: { chainId: chain, address: event.from },
      recipient: { chainId: chain, address: event.to }
    },
    segments: [
      {
        id: `${id}:origin`,
        role: 'origin',
        target: { kind: 'onchain', chainId: chain },
        status: 'final',
        evidence: { transactionHash: event.txHash, blockHeight: event.blockNumber }
      }
    ],
    completeness,
    createdAt: event.timestampMs,
    updatedAt: event.timestampMs
  }
}

function pendingItem(
  pending: StarknetPendingTransfer,
  scope: ActivityScope,
  account: string,
  chainId: string
): ActivityItem {
  const chain = parseChainId(chainId).id
  const assetId = parseAssetId(pending.assetId).id
  const feeAssetId = parseAssetId(pending.feeAssetId).id
  const failed = pending.status === 'failed'
  const status = failed ? 'failed' : pending.status === 'final' ? 'final' : 'broadcast'
  const hash = pending.invokeHash ?? pending.deployHash ?? pending.transactionId
  const id = `local:starknet:${pending.transactionId}`
  return {
    id,
    source: 'wallet-v2',
    scope,
    kind: 'transfer',
    status,
    ...(failed && pending.failureCode ? { failureCode: pending.failureCode } : {}),
    snapshot: {
      schemaVersion: 1,
      direction:
        canonicalStarknetFelt(pending.sender) === account &&
        canonicalStarknetFelt(pending.recipient) === account
          ? 'self'
          : canonicalStarknetFelt(pending.sender) === account
            ? 'outgoing'
            : 'incoming',
      primaryAmount: { assetId, amountRaw: pending.amountRaw },
      feeLimit: { assetId: feeAssetId, amountRaw: pending.maxFeeRaw },
      sender: { chainId: chain, address: canonicalStarknetFelt(pending.sender) ?? pending.sender },
      recipient: {
        chainId: chain,
        address: canonicalStarknetFelt(pending.recipient) ?? pending.recipient
      }
    },
    segments: [
      {
        id: `${id}:origin`,
        role: 'origin',
        target: { kind: 'onchain', chainId: chain },
        status,
        ...(failed && pending.failureCode ? { failureCode: pending.failureCode } : {}),
        evidence: { transactionHash: hash }
      }
    ],
    completeness: 'complete',
    createdAt: pending.createdAt,
    updatedAt: pending.createdAt
  }
}
