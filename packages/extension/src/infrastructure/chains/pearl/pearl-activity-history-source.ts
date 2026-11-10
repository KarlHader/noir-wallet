import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseSupportedPearlAddress, type PearlHistoryTransaction } from '@/core/chains/pearl'
import type { AssetId, ChainId } from '@/core/chains/domain'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import {
  PearlRpcError,
  type PearlActivityHistoryRpc,
  type PearlDiscoveryRpc
} from './pearl-blockbook-client'

const DEFAULT_CONCURRENCY = 4
const MAXIMUM_CONCURRENCY = 8
const MAXIMUM_HISTORY_ADDRESSES = 64
const MAXIMUM_ACTIVITY_ITEMS = 200

export const PEARL_ACTIVITY_HISTORY_LIMITS = Object.freeze({
  addresses: MAXIMUM_HISTORY_ADDRESSES,
  items: MAXIMUM_ACTIVITY_ITEMS
})

export interface PearlActivityHistorySourceConfig {
  readonly chainId: string
  readonly assetId: string
  readonly requiredConfirmations: number
  readonly rpc: PearlActivityHistoryRpc & Pick<PearlDiscoveryRpc, 'getTipHeight'>
  readonly concurrency?: number
  readonly now?: () => number
}

export interface ReadPearlAddressActivityInput {
  readonly scope: ActivityScope
  readonly ownedAddresses: readonly string[]
  readonly historyAddresses: readonly string[]
  readonly signal?: AbortSignal
}

export interface PearlActivityHistorySource {
  readonly readAddressActivity: (
    input: ReadPearlAddressActivityInput
  ) => Promise<readonly ActivityItem[]>
}

function parseConcurrency(value: number | undefined): number {
  const parsed = value ?? DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAXIMUM_CONCURRENCY) {
    throw new Error('Invalid Pearl history concurrency')
  }
  return parsed
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return Object.freeze(results)
}

function mapTransaction(
  transaction: PearlHistoryTransaction,
  tipHeight: number,
  requiredConfirmations: number,
  chainId: ChainId,
  assetId: AssetId,
  scope: ActivityScope,
  now: number
): ActivityItem {
  let confirmations = 0
  if (transaction.status.confirmed) {
    const blockHeight = transaction.status.blockHeight
    if (blockHeight === undefined) {
      throw new PearlRpcError('invalid-response', 'Incomplete confirmed Pearl history status')
    }
    if (blockHeight > tipHeight) {
      throw new PearlRpcError('invalid-response', 'Pearl history block is ahead of tip')
    }
    confirmations = tipHeight - blockHeight + 1
  }
  const status =
    transaction.status.confirmed && confirmations >= requiredConfirmations
      ? ('final' as const)
      : ('confirming' as const)
  const id = `rpc:pearl:${transaction.transactionId}`
  const timestamp =
    transaction.status.confirmed && transaction.status.blockTime !== undefined
      ? transaction.status.blockTime * 1_000
      : now
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope,
    kind: 'transfer' as const,
    status,
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      direction: 'incoming' as const,
      ...(transaction.valueSats === undefined
        ? {}
        : {
            primaryAmount: Object.freeze({ assetId, amountRaw: transaction.valueSats })
          })
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `${id}:origin`,
        role: 'origin' as const,
        target: Object.freeze({ kind: 'onchain' as const, chainId }),
        status,
        evidence: Object.freeze({
          transactionHash: transaction.transactionId,
          ...(transaction.status.confirmed
            ? {
                blockHash: transaction.status.blockHash,
                blockHeight: transaction.status.blockHeight,
                confirmations,
                requiredConfirmations
              }
            : { confirmations: 0, requiredConfirmations })
        })
      })
    ]),
    completeness: 'partial' as const,
    createdAt: timestamp,
    updatedAt: timestamp
  })
}

export function createPearlActivityHistorySource(
  config: PearlActivityHistorySourceConfig
): PearlActivityHistorySource {
  const chain = parseChainId(config.chainId)
  const asset = parseAssetId(config.assetId)
  if (asset.chainId !== chain.id) {
    throw new Error('Pearl activity asset does not match its chain')
  }
  const requiredConfirmations = config.requiredConfirmations
  if (!Number.isSafeInteger(requiredConfirmations) || requiredConfirmations <= 0) {
    throw new Error('Invalid Pearl required confirmations')
  }
  const concurrency = parseConcurrency(config.concurrency)
  const now = config.now ?? Date.now

  return Object.freeze({
    readAddressActivity: async (input: ReadPearlAddressActivityInput) => {
      if (input.historyAddresses.length > MAXIMUM_HISTORY_ADDRESSES) {
        throw new Error('Invalid Pearl history address set')
      }
      const history = input.historyAddresses.map(address =>
        parseSupportedPearlAddress(address, chain.id)
      )
      if (history.length === 0) return Object.freeze([])
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.signal?.aborted) controller.abort()
      try {
        const tipHeight = await config.rpc.getTipHeight(controller.signal)
        const groups = await mapWithConcurrency(history, concurrency, address =>
          config.rpc.getAddressTransactions(address, controller.signal)
        )
        const transactions = new Map<string, PearlHistoryTransaction>()
        for (const transaction of groups.flat()) {
          const existing = transactions.get(transaction.transactionId)
          if (existing && JSON.stringify(existing) !== JSON.stringify(transaction)) {
            throw new PearlRpcError(
              'invalid-response',
              'Pearl history providers returned conflicting transaction data'
            )
          }
          transactions.set(transaction.transactionId, transaction)
        }
        const current = now()
        return Object.freeze(
          [...transactions.values()]
            .map(transaction =>
              mapTransaction(
                transaction,
                tipHeight,
                requiredConfirmations,
                chain.id,
                asset.id,
                input.scope,
                current
              )
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, MAXIMUM_ACTIVITY_ITEMS)
        )
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
      }
    }
  })
}
