import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import type { TransactionAssetEffects } from '@/core/transactions/domain'
import { EvmRpcError } from './evm-rpc-client'
import { isErc20ApproveCalldata } from './evm-contract-call-classification'

export const EVM_HISTORY_LIMIT = 200
export const EVM_ACTIVITY_ITEM_LIMIT = 2_000

export interface TrackedErc20Asset {
  readonly assetId: string
  readonly contract: string
  readonly decimals: number
}

export interface ReadEvmAddressActivityInput {
  readonly scope: ActivityScope
  readonly address: string
  readonly fromBlock?: number
  readonly historyPageCount?: number
  readonly signal?: AbortSignal
}

export interface FindEvmConfirmedReplacementInput {
  readonly sender: string
  readonly nonce: string
  readonly excludedTransactionHash: string
  readonly signal?: AbortSignal
}

export interface EvmConfirmedReplacement {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly confirmedAt: number
}

export interface EvmActivityHistorySource {
  readonly readAddressActivity: (
    input: ReadEvmAddressActivityInput
  ) => Promise<readonly ActivityItem[]>
  readonly readAddressActivityWithMetadata?: (
    input: ReadEvmAddressActivityInput
  ) => Promise<{ readonly items: readonly ActivityItem[]; readonly hasMore: boolean }>
  readonly findConfirmedReplacement: (
    input: FindEvmConfirmedReplacementInput
  ) => Promise<EvmConfirmedReplacement | null>
}

export interface IndexedTransaction {
  readonly transactionHash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly confirmations: number
  readonly from: string
  readonly to?: string
  readonly valueRaw: string
  readonly gasPriceRaw: string
  readonly gasUsed: string
  readonly nonce: string
  readonly timestamp: number
  readonly failed: boolean
  readonly input?: string
}

export interface IndexedTokenTransfer {
  readonly transactionHash: string
  readonly blockHash?: string
  readonly blockHeight: number
  readonly confirmations: number
  readonly from: string
  readonly to: string
  readonly amountRaw: string
  readonly nonce?: string
  readonly timestamp: number
  readonly assetId: ReturnType<typeof parseAssetId>['id']
}

export function isZeroValueEvmTokenActivity(item: ActivityItem): boolean {
  const amount = item.snapshot?.primaryAmount
  return (
    item.source === 'rpc' &&
    item.id.startsWith('rpc:evm:') &&
    item.kind === 'transfer' &&
    amount?.amountRaw === '0' &&
    amount.assetId.startsWith('eip155:') &&
    amount.assetId.includes('/erc20:')
  )
}

export function isUntrackedEvmTokenActivity(
  item: ActivityItem,
  trackedAssetIds: ReadonlySet<string>
): boolean {
  if (item.source !== 'rpc' || !item.id.startsWith('rpc:evm:') || !item.id.endsWith(':token')) {
    return false
  }
  const amount = item.snapshot?.primaryAmount
  if (amount) {
    return amount.assetId.includes('/erc20:') && !trackedAssetIds.has(amount.assetId)
  }
  return !item.segments.some(segment =>
    segment.evidence?.assetEffects?.changes.some(change => trackedAssetIds.has(change.assetId))
  )
}

export function filterTrackedEvmTokenActivity(
  item: ActivityItem,
  trackedAssetIds: ReadonlySet<string>
): ActivityItem | undefined {
  if (isUntrackedEvmTokenActivity(item, trackedAssetIds)) return undefined
  if (item.source !== 'rpc' || !item.id.startsWith('rpc:evm:') || !item.id.endsWith(':token')) {
    return item
  }
  const segments = item.segments.map(segment => {
    const effects = segment.evidence?.assetEffects
    if (!effects) return segment
    const changes = effects.changes.filter(change => trackedAssetIds.has(change.assetId))
    if (changes.length === effects.changes.length) return segment
    return Object.freeze({
      ...segment,
      evidence: Object.freeze({
        ...segment.evidence,
        assetEffects: Object.freeze({ ...effects, changes: Object.freeze(changes) })
      })
    })
  })
  return segments.every((segment, index) => segment === item.segments[index])
    ? item
    : Object.freeze({ ...item, segments: Object.freeze(segments) })
}

function directionFor(address: string, from: string, to: string | undefined) {
  if (from === address && to === address) return 'self' as const
  if (from === address) return 'outgoing' as const
  if (to === address) return 'incoming' as const
  throw new EvmRpcError('invalid-response', 'EVM history item does not involve the address')
}

function transactionEvidence(
  transaction: IndexedTransaction | IndexedTokenTransfer,
  assetEffects?: TransactionAssetEffects
) {
  return Object.freeze({
    transactionHash: transaction.transactionHash,
    ...(assetEffects === undefined ? {} : { assetEffects }),
    ...(transaction.nonce === undefined
      ? {}
      : { externalReference: `evm-nonce:${transaction.nonce}` }),
    ...(transaction.blockHash === undefined ? {} : { blockHash: transaction.blockHash }),
    blockHeight: transaction.blockHeight,
    confirmations: transaction.confirmations
  })
}

function observedEffects(input: {
  readonly address: string
  readonly nativeAssetId: ReturnType<typeof parseAssetId>['id']
  readonly normal?: IndexedTransaction
  readonly transfers: readonly IndexedTokenTransfer[]
  readonly partial: boolean
}): TransactionAssetEffects | undefined {
  const balance = new Map<string, bigint>()
  const add = (assetId: string, amount: bigint) => {
    balance.set(assetId, (balance.get(assetId) ?? 0n) + amount)
  }
  const address = input.address.toLowerCase()
  for (const transfer of input.transfers) {
    if (transfer.from.toLowerCase() === address) add(transfer.assetId, -BigInt(transfer.amountRaw))
    if (transfer.to.toLowerCase() === address) add(transfer.assetId, BigInt(transfer.amountRaw))
  }
  if (input.normal && input.normal.valueRaw !== '0') {
    if (input.normal.from.toLowerCase() === address)
      add(input.nativeAssetId, -BigInt(input.normal.valueRaw))
    if (input.normal.to?.toLowerCase() === address)
      add(input.nativeAssetId, BigInt(input.normal.valueRaw))
  }
  const nonzero = [...balance.entries()].filter(([, amount]) => amount !== 0n)
  if (
    nonzero.length > 128 ||
    nonzero.some(([, amount]) => (amount < 0n ? -amount : amount).toString().length > 78)
  ) {
    return undefined
  }
  return Object.freeze({
    source: 'indexer',
    completeness: input.partial ? 'partial' : 'complete',
    changes: Object.freeze(
      nonzero
        .map(([assetId, amount]) =>
          Object.freeze({
            assetId: parseAssetId(assetId).id,
            amountRaw: (amount < 0n ? -amount : amount).toString(),
            direction: amount < 0n ? ('outgoing' as const) : ('incoming' as const)
          })
        )
        .sort((left, right) => left.assetId.localeCompare(right.assetId))
    )
  })
}

function hasConflictingInclusion(
  normal: IndexedTransaction | undefined,
  transfers: readonly IndexedTokenTransfer[]
): boolean {
  const entries = normal ? [normal, ...transfers] : transfers
  return (
    new Set(entries.map(entry => entry.blockHeight)).size > 1 ||
    new Set(
      entries.flatMap(entry =>
        entry.blockHash === undefined ? [] : [entry.blockHash.toLowerCase()]
      )
    ).size > 1
  )
}

function mapNormalActivityItem(
  transaction: IndexedTransaction,
  input: ReadEvmAddressActivityInput,
  chainId: ReturnType<typeof parseChainId>['id'],
  nativeAssetId: ReturnType<typeof parseAssetId>['id'],
  partial: boolean,
  transfers: readonly IndexedTokenTransfer[]
): ActivityItem {
  const address = input.address.toLowerCase()
  const direction = directionFor(address, transaction.from, transaction.to)
  const isApproval = transaction.valueRaw === '0' && isErc20ApproveCalldata(transaction.input)
  const calldata = transaction.input?.toLowerCase() ?? ''
  const incompatible = hasConflictingInclusion(transaction, transfers)
  const directTokenTransfer =
    !incompatible &&
    transaction.valueRaw === '0' &&
    transfers.length === 1 &&
    transaction.to?.toLowerCase() === parseAssetId(transfers[0].assetId).reference.toLowerCase() &&
    /^0xa9059cbb[0-9a-f]{128}$/.test(calldata) &&
    calldata.slice(10, 34) === '0'.repeat(24) &&
    `0x${calldata.slice(34, 74)}` === transfers[0].to.toLowerCase() &&
    BigInt(`0x${calldata.slice(74)}`) === BigInt(transfers[0].amountRaw) &&
    transfers[0].from.toLowerCase() === address
  const isTransfer =
    (transaction.valueRaw !== '0' &&
      (!transaction.input || transaction.input === '0x') &&
      transfers.length === 0) ||
    directTokenTransfer
  const effects =
    transaction.failed || incompatible
      ? undefined
      : observedEffects({
          address,
          nativeAssetId,
          normal: transaction,
          transfers,
          partial:
            partial || !isTransfer || transfers.some(transfer => transfer.blockHash === undefined)
        })
  const incomplete = partial || incompatible || (!transaction.failed && effects === undefined)
  const status = transaction.failed ? ('failed' as const) : ('final' as const)
  const id = `rpc:evm:${chainId}:${transaction.transactionHash}:native`
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope: input.scope,
    kind: isTransfer
      ? ('transfer' as const)
      : isApproval
        ? ('approve' as const)
        : ('contract-call' as const),
    status,
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      direction: isTransfer ? direction : ('contract' as const),
      ...(transaction.valueRaw !== '0' || directTokenTransfer
        ? {
            primaryAmount: Object.freeze({
              assetId: directTokenTransfer ? transfers[0].assetId : nativeAssetId,
              amountRaw: directTokenTransfer ? transfers[0].amountRaw : transaction.valueRaw
            })
          }
        : {}),
      sender: Object.freeze({ chainId, address: transaction.from }),
      ...(transaction.to === undefined
        ? {}
        : {
            recipient: Object.freeze({
              chainId,
              address: directTokenTransfer ? transfers[0].to : transaction.to
            })
          })
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `${id}:origin`,
        role: 'origin' as const,
        target: Object.freeze({ kind: 'onchain' as const, chainId }),
        status,
        evidence: transactionEvidence(transaction, effects),
        ...(transaction.failed ? { failureCode: 'reverted' as const } : {})
      })
    ]),
    completeness: incomplete ? ('partial' as const) : ('complete' as const),
    createdAt: transaction.timestamp,
    updatedAt: transaction.timestamp,
    ...(transaction.failed ? { failureCode: 'reverted' as const } : {})
  })
}

function mapTokenActivityItem(
  transfers: readonly IndexedTokenTransfer[],
  input: ReadEvmAddressActivityInput,
  chainId: ReturnType<typeof parseChainId>['id'],
  nativeAssetId: ReturnType<typeof parseAssetId>['id'],
  partial: boolean
): ActivityItem {
  const transfer = transfers[0]
  const address = input.address.toLowerCase()
  const single = transfers.length === 1
  const direction = single ? directionFor(address, transfer.from, transfer.to) : 'contract'
  const id = `rpc:evm:${chainId}:${transfer.transactionHash}:token`
  const status = 'final' as const
  const effects = hasConflictingInclusion(undefined, transfers)
    ? undefined
    : observedEffects({ address, nativeAssetId, transfers, partial: true })
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope: input.scope,
    kind: single ? ('transfer' as const) : ('contract-call' as const),
    status,
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      direction,
      ...(single
        ? {
            primaryAmount: Object.freeze({
              assetId: transfer.assetId,
              amountRaw: transfer.amountRaw
            })
          }
        : {}),
      ...(single
        ? {
            sender: Object.freeze({ chainId, address: transfer.from }),
            recipient: Object.freeze({ chainId, address: transfer.to })
          }
        : {})
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `${id}:origin`,
        role: 'origin' as const,
        target: Object.freeze({ kind: 'onchain' as const, chainId }),
        status,
        evidence: transactionEvidence(transfer, effects)
      })
    ]),
    completeness: partial || effects === undefined ? ('partial' as const) : ('complete' as const),
    createdAt: transfer.timestamp,
    updatedAt: transfer.timestamp
  })
}

export function mapEvmIndexedActivity(input: {
  readonly request: ReadEvmAddressActivityInput
  readonly chainId: string
  readonly nativeAssetId: string
  readonly normalTransactions: readonly IndexedTransaction[]
  readonly tokenTransfers: readonly IndexedTokenTransfer[]
  readonly sourcePartial: boolean
  readonly itemLimit?: number
}): readonly ActivityItem[] {
  const chain = parseChainId(input.chainId)
  const nativeAssetId = parseAssetId(input.nativeAssetId)
  const tokenTransfersByHash = new Map<string, IndexedTokenTransfer[]>()
  for (const transfer of input.tokenTransfers) {
    if (transfer.amountRaw === '0') continue
    const group = tokenTransfersByHash.get(transfer.transactionHash) ?? []
    group.push(transfer)
    tokenTransfersByHash.set(transfer.transactionHash, group)
  }
  const normalByHash = new Map(
    input.normalTransactions.map(transaction => [transaction.transactionHash, transaction])
  )
  const tokenItems: ActivityItem[] = []
  for (const [hash, transfers] of tokenTransfersByHash) {
    const normal = normalByHash.get(hash)
    if (normal) continue
    tokenItems.push(
      mapTokenActivityItem(
        transfers,
        input.request,
        chain.id,
        nativeAssetId.id,
        input.sourcePartial ||
          transfers.some(
            transfer => transfer.blockHash === undefined || transfer.nonce === undefined
          )
      )
    )
  }
  const normalItems = input.normalTransactions.map(transaction =>
    mapNormalActivityItem(
      transaction,
      input.request,
      chain.id,
      nativeAssetId.id,
      input.sourcePartial,
      tokenTransfersByHash.get(transaction.transactionHash) ?? []
    )
  )
  return Object.freeze(
    [...normalItems, ...tokenItems]
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          right.createdAt - left.createdAt ||
          left.id.localeCompare(right.id)
      )
      .slice(0, input.itemLimit ?? EVM_HISTORY_LIMIT)
  )
}
