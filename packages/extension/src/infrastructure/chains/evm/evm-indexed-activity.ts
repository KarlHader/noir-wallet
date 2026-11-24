import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import type { TransactionAssetEffects } from '@/core/transactions/domain'
import { EvmRpcError } from './evm-rpc-client'
import { decodeErc20CalldataRequest } from './evm-contract-call-classification'

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

export function isIndexedBaseAcrossReceipt(item: ActivityItem): boolean {
  return item.id.startsWith('rpc:evm:eip155:8453:') && item.id.includes(':native-receive:across:')
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
  if (item.source !== 'rpc' || !item.id.startsWith('rpc:evm:')) {
    return false
  }
  const amount = item.snapshot?.primaryAmount
  const tokenOnly = item.id.endsWith(':token')
  if (amount) {
    return (
      (tokenOnly || item.kind === 'transfer') &&
      amount.assetId.includes('/erc20:') &&
      !trackedAssetIds.has(amount.assetId)
    )
  }
  if (!tokenOnly) return false
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
  return undefined
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
  const sender = transaction.from.toLowerCase()
  const recipient = transaction.to?.toLowerCase()
  const direction = directionFor(address, sender, recipient)
  if (
    !direction &&
    !transfers.some(
      transfer => transfer.from.toLowerCase() === address || transfer.to.toLowerCase() === address
    )
  ) {
    throw new EvmRpcError('invalid-response', 'EVM history item does not involve the address')
  }

  const calldata = decodeErc20CalldataRequest(transaction.input)
  const isApproval = transaction.valueRaw === '0' && calldata?.kind === 'approve'
  const incompatible = hasConflictingInclusion(transaction, transfers)
  const singleTransfer = transfers.length === 1 ? transfers[0] : undefined
  const tokenDirection = singleTransfer
    ? directionFor(address, singleTransfer.from.toLowerCase(), singleTransfer.to.toLowerCase())
    : undefined
  const directTokenTransfer =
    singleTransfer &&
    calldata?.kind === 'transfer' &&
    recipient === parseAssetId(singleTransfer.assetId).reference.toLowerCase() &&
    sender === singleTransfer.from.toLowerCase() &&
    calldata.recipient === singleTransfer.to.toLowerCase() &&
    calldata.amountRaw === singleTransfer.amountRaw
  const passiveTokenCredit = !partial && sender !== address && tokenDirection === 'incoming'
  const tokenTransfer =
    !incompatible &&
    transaction.valueRaw === '0' &&
    tokenDirection &&
    (tokenDirection !== 'incoming' || !transaction.failed) &&
    (directTokenTransfer || passiveTokenCredit)
      ? singleTransfer
      : undefined
  const nativeTransfer =
    direction &&
    recipient !== undefined &&
    transaction.valueRaw !== '0' &&
    (!transaction.input || transaction.input === '0x') &&
    transfers.length === 0 &&
    (direction !== 'incoming' || !transaction.failed)
  const transferDirection = tokenTransfer ? tokenDirection : nativeTransfer ? direction : undefined
  const primaryAmount = tokenTransfer
    ? { assetId: tokenTransfer.assetId, amountRaw: tokenTransfer.amountRaw }
    : direction && transaction.valueRaw !== '0' && (direction !== 'incoming' || !transaction.failed)
      ? { assetId: nativeAssetId, amountRaw: transaction.valueRaw }
      : undefined
  const snapshotRecipient = tokenTransfer?.to ?? transaction.to
  const effects =
    transaction.failed || incompatible
      ? undefined
      : observedEffects({
          address,
          nativeAssetId,
          normal: transaction,
          transfers,
          partial: partial || transferDirection === undefined
        })
  const incomplete = partial || incompatible || (!transaction.failed && effects === undefined)
  const status = transaction.failed ? ('failed' as const) : ('final' as const)
  const id = `rpc:evm:${chainId}:${transaction.transactionHash}:native`
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope: input.scope,
    kind: transferDirection
      ? ('transfer' as const)
      : isApproval
        ? ('approve' as const)
        : ('contract-call' as const),
    status,
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      direction: transferDirection ?? ('contract' as const),
      ...(primaryAmount === undefined ? {} : { primaryAmount: Object.freeze(primaryAmount) }),
      sender: Object.freeze({ chainId, address: tokenTransfer?.from ?? transaction.from }),
      ...(snapshotRecipient === undefined
        ? {}
        : { recipient: Object.freeze({ chainId, address: snapshotRecipient }) })
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
  partial: boolean,
  acrossLogIndex?: number
): ActivityItem {
  const transfer = transfers[0]
  const address = input.address.toLowerCase()
  const single = transfers.length === 1
  const direction = single
    ? directionFor(address, transfer.from.toLowerCase(), transfer.to.toLowerCase())
    : 'contract'
  if (direction === undefined) {
    throw new EvmRpcError('invalid-response', 'EVM history item does not involve the address')
  }
  const suffix = acrossLogIndex === undefined ? 'token' : `native-receive:across:${acrossLogIndex}`
  const id = `rpc:evm:${chainId}:${transfer.transactionHash}:${suffix}`
  const status = 'final' as const
  const effects = hasConflictingInclusion(undefined, transfers)
    ? undefined
    : observedEffects({
        address,
        nativeAssetId,
        transfers,
        partial: partial || direction !== 'incoming'
      })
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope: input.scope,
    kind: acrossLogIndex !== undefined ? 'receive' : single ? 'transfer' : 'contract-call',
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
  readonly indexedNativeReceipts?: readonly (IndexedTokenTransfer & { readonly logIndex: number })[]
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
  const receipts = new Map<string, ActivityItem>()
  for (const transfer of input.indexedNativeReceipts ?? []) {
    const key = `${transfer.transactionHash}:${transfer.logIndex}`
    if (receipts.has(key)) continue
    receipts.set(
      key,
      mapTokenActivityItem(
        [transfer],
        input.request,
        chain.id,
        nativeAssetId.id,
        false,
        transfer.logIndex
      )
    )
  }
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
        input.sourcePartial
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
    [...normalItems, ...tokenItems, ...receipts.values()]
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          right.createdAt - left.createdAt ||
          left.id.localeCompare(right.id)
      )
      .slice(0, input.itemLimit ?? EVM_HISTORY_LIMIT)
  )
}
