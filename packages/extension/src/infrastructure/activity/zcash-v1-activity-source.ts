import type { ActivityItem, ActivityScope, ActivitySegment } from '@/core/activity'
import { createAssetId, parseAssetId, parseChainId } from '@/core/chains/registry'
import type { ChainId } from '@/core/chains/domain'
import {
  getBitcoinChainId,
  getZcashChainId
} from '@/core/chains/registry/product-chain-definitions'
import type {
  TransactionFailureCode,
  TransactionKind,
  TransactionLifecycleStatus
} from '@/core/transactions/domain'
import { getEvmNetworkConfig, getEvmNetworkConfigs } from '@/config/networks'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap/rhea-swap-asset-identity'
import type { Transaction, TransactionType } from '@/types'
import { getZcashIntentsOriginStatus } from '@/lib/cross-chain-transaction'
import { parseDisplayUnitAmount } from '@/lib/number-format'

const ZCASH_DECIMALS = 8
const RAW_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/
function decimalToRaw(value: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error('Invalid Zcash V1 Activity amount')
  }
  const fraction = value.split('.')[1] ?? ''
  if (fraction.length > ZCASH_DECIMALS) {
    throw new Error('Zcash V1 Activity amount exceeds ZEC precision')
  }
  const raw = parseDisplayUnitAmount(value, ZCASH_DECIMALS)
  if (raw.length > 78) throw new Error('Zcash V1 Activity amount exceeds the storage limit')
  return raw
}

function mapKind(type: TransactionType): TransactionKind {
  return type === 'send' || type === 'unshield' ? 'transfer' : type
}

function mapStatus(transaction: Transaction): TransactionLifecycleStatus {
  switch (transaction.status) {
    case 'success':
      return 'final'
    case 'failed':
      return 'failed'
    case 'confirming':
    case 'relay_confirmed':
      return 'confirming'
    case 'pending':
      return transaction.txHash ? 'broadcast' : 'created'
  }
}

function direction(type: TransactionType): 'incoming' | 'outgoing' | 'self' {
  if (type === 'receive' || type === 'withdraw' || type === 'claim') return 'incoming'
  if (type === 'shield' || type === 'unshield') return 'self'
  return 'outgoing'
}

function isCrossChain(type: TransactionType): type is 'swap' | 'supply' | 'withdraw' | 'claim' {
  return type === 'swap' || type === 'supply' || type === 'withdraw' || type === 'claim'
}

function crossChainFailure(transaction: Transaction): TransactionFailureCode | undefined {
  if (transaction.status !== 'failed') return undefined
  if (/refunded/i.test(transaction.memo ?? '')) return 'refunded'
  return transaction.depositAddress || transaction.txHash ? 'relay-failed' : 'unknown'
}

function externalChainId(chain: string, transaction: Transaction): ChainId | null {
  const normalized = chain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (normalized === 'zec' || normalized === 'zcash' || normalized === 'zcashtestnet') {
    return parseChainId(getZcashChainId(transaction.network)).id
  }
  if (normalized === 'near' || normalized === 'nearmainnet') {
    return parseChainId('near:mainnet').id
  }
  if (normalized === 'ethereum' || normalized === 'eth' || normalized === 'sepolia') {
    return parseChainId(getEvmNetworkConfig(transaction.network).chainId).id
  }
  const evmNetwork = getEvmNetworkConfigs(transaction.network).find(config =>
    [config.displayName, config.networkName, config.iconChain].some(
      candidate => candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
    )
  )
  if (evmNetwork) return parseChainId(evmNetwork.chainId).id
  if (normalized === 'bitcoin' || normalized === 'btc' || normalized === 'bitcointestnet') {
    return parseChainId(getBitcoinChainId(transaction.network)).id
  }
  return null
}

function originStatus(transaction: Transaction): TransactionLifecycleStatus {
  if (!transaction.txHash) return transaction.status === 'failed' ? 'failed' : 'created'
  if (transaction.status === 'success' || transaction.status === 'relay_confirmed') return 'final'
  return 'broadcast'
}

function relayStatus(transaction: Transaction): TransactionLifecycleStatus {
  switch (transaction.status) {
    case 'success':
    case 'relay_confirmed':
      return 'final'
    case 'failed':
      return 'failed'
    case 'confirming':
    case 'pending':
      return transaction.txHash ? 'confirming' : 'created'
  }
}

function destinationStatus(transaction: Transaction): TransactionLifecycleStatus {
  switch (transaction.status) {
    case 'success':
      return 'final'
    case 'relay_confirmed':
    case 'confirming':
      return 'confirming'
    case 'failed':
      return 'failed'
    case 'pending':
      return 'broadcast'
  }
}

function crossChainSegments(
  transaction: Transaction,
  zcashChainId: ChainId,
  relayReference: string | undefined
): readonly ActivitySegment[] {
  const failureCode = crossChainFailure(transaction)
  const outboundFromZcash = transaction.type === 'swap' || transaction.type === 'supply'
  const originChain =
    transaction.chainHashes
      ?.find(item => item.hash.toLowerCase() === transaction.txHash.toLowerCase())
      ?.chain.trim() ?? 'Near'
  const originChainId = outboundFromZcash
    ? zcashChainId
    : (externalChainId(originChain, transaction) ?? parseChainId('near:mainnet').id)
  const segments: ActivitySegment[] = [
    Object.freeze({
      id: `${transaction.id}:origin`,
      role: 'origin' as const,
      target: Object.freeze({ kind: 'onchain' as const, chainId: originChainId }),
      status: outboundFromZcash
        ? getZcashIntentsOriginStatus(transaction)
        : originStatus(transaction),
      ...(transaction.txHash
        ? { evidence: Object.freeze({ transactionHash: transaction.txHash }) }
        : {}),
      ...(!transaction.txHash && failureCode ? { failureCode } : {})
    }),
    Object.freeze({
      id: `${transaction.id}:relay`,
      role: 'relay' as const,
      target: Object.freeze({ kind: 'relay' as const, provider: 'NEAR Intents' }),
      status: relayStatus(transaction),
      ...(relayReference ? { evidence: Object.freeze({ externalReference: relayReference }) } : {}),
      ...(failureCode ? { failureCode } : {})
    })
  ]

  const destinationHashes = new Map<
    string,
    { readonly hash: string; readonly chain: string; readonly chainId?: ChainId }
  >()
  for (const item of transaction.chainHashes ?? []) {
    if (item.hash.toLowerCase() === transaction.txHash.toLowerCase()) continue
    destinationHashes.set(item.hash.toLowerCase(), item)
  }
  if (
    transaction.destinationTxHash &&
    transaction.destinationTxHash.toLowerCase() !== transaction.txHash.toLowerCase() &&
    !destinationHashes.has(transaction.destinationTxHash.toLowerCase())
  ) {
    const destinationAssetId = transaction.quoteBinding?.destinationAsset
      ? resolveRheaSwapCanonicalAssetId(
          transaction.quoteBinding.destinationAsset,
          transaction.network
        )
      : null
    const destinationChainId =
      transaction.type === 'withdraw' || transaction.type === 'claim'
        ? zcashChainId
        : destinationAssetId
          ? parseAssetId(destinationAssetId).chainId
          : undefined
    destinationHashes.set(transaction.destinationTxHash.toLowerCase(), {
      hash: transaction.destinationTxHash,
      chain: transaction.quoteBinding?.destinationChain ?? 'Destination chain',
      ...(destinationChainId ? { chainId: destinationChainId } : {})
    })
  }

  let index = 0
  for (const item of destinationHashes.values()) {
    const chainId = item.chainId ?? externalChainId(item.chain, transaction)
    segments.push(
      Object.freeze({
        id: `${transaction.id}:destination:${index}`,
        role: 'destination' as const,
        target: chainId
          ? Object.freeze({ kind: 'onchain' as const, chainId })
          : Object.freeze({ kind: 'relay' as const, provider: item.chain || 'Destination chain' }),
        status: destinationStatus(transaction),
        evidence: Object.freeze({
          transactionHash: item.hash,
          ...(chainId === zcashChainId && transaction.confirmations !== undefined
            ? { confirmations: transaction.confirmations }
            : {}),
          ...(chainId === zcashChainId && transaction.requiredConfirmations !== undefined
            ? { requiredConfirmations: transaction.requiredConfirmations }
            : {})
        }),
        ...(transaction.status === 'failed' ? { failureCode: failureCode ?? 'relay-failed' } : {})
      })
    )
    index += 1
  }
  if (transaction.type === 'swap' && destinationHashes.size === 0) {
    const destinationAssetId = transaction.quoteBinding?.destinationAsset
      ? resolveRheaSwapCanonicalAssetId(
          transaction.quoteBinding.destinationAsset,
          transaction.network
        )
      : null
    const destinationChainId = destinationAssetId
      ? parseAssetId(destinationAssetId).chainId
      : transaction.quoteBinding?.destinationChain
        ? externalChainId(transaction.quoteBinding.destinationChain, transaction)
        : null
    if (destinationChainId) {
      segments.push(
        Object.freeze({
          id: `${transaction.id}:destination:0`,
          role: 'destination' as const,
          target: Object.freeze({ kind: 'onchain' as const, chainId: destinationChainId }),
          status: transaction.status === 'success' ? ('final' as const) : ('created' as const)
        })
      )
    }
  }
  return Object.freeze(segments)
}

export function mapZcashV1TransactionToActivityItem(
  transaction: Transaction,
  scope: ActivityScope
): ActivityItem {
  const chainId = parseChainId(getZcashChainId(transaction.network)).id
  const assetId = createAssetId(chainId, 'slip44', '133')
  const status = mapStatus(transaction)
  const transactionHash = transaction.destinationTxHash || transaction.txHash
  const crossChain = isCrossChain(transaction.type)
  const failureCode = crossChain
    ? crossChainFailure(transaction)
    : transaction.status === 'failed'
      ? transaction.failureReason === 'expired'
        ? 'expired'
        : 'unknown'
      : undefined
  const relayReference = transaction.depositAddress || transaction.quoteBinding?.depositAddress
  const counterAssetId = transaction.quoteBinding?.destinationAsset
    ? resolveRheaSwapCanonicalAssetId(
        transaction.quoteBinding.destinationAsset,
        transaction.network
      )
    : null
  const counterAmount =
    counterAssetId &&
    transaction.quoteBinding?.expectedAmountOut &&
    RAW_AMOUNT_PATTERN.test(transaction.quoteBinding.expectedAmountOut)
      ? Object.freeze({
          assetId: counterAssetId,
          amountRaw: transaction.quoteBinding.expectedAmountOut
        })
      : undefined
  const finalRecipientChainId = counterAssetId
    ? parseAssetId(counterAssetId).chainId
    : transaction.quoteBinding?.destinationChain
      ? externalChainId(transaction.quoteBinding.destinationChain, transaction)
      : null
  const finalRecipient =
    transaction.type === 'swap' && transaction.quoteBinding?.recipient && finalRecipientChainId
      ? Object.freeze({
          chainId: finalRecipientChainId,
          address: transaction.quoteBinding.recipient
        })
      : undefined
  const segments = crossChain
    ? crossChainSegments(transaction, chainId, relayReference)
    : Object.freeze([
        Object.freeze({
          id: `${transaction.id}:zcash`,
          role: 'origin' as const,
          target: Object.freeze({ kind: 'onchain' as const, chainId }),
          status,
          ...(transactionHash
            ? {
                evidence: Object.freeze({
                  transactionHash,
                  ...(transaction.confirmations === undefined
                    ? {}
                    : { confirmations: transaction.confirmations }),
                  ...(transaction.requiredConfirmations === undefined
                    ? {}
                    : { requiredConfirmations: transaction.requiredConfirmations })
                })
              }
            : {}),
          ...(failureCode ? { failureCode } : {})
        })
      ])
  return Object.freeze({
    id: transaction.id,
    source: 'zcash-v1',
    scope: Object.freeze({
      keyDomainId: scope.keyDomainId,
      accountId: scope.accountId
    }),
    kind: mapKind(transaction.type),
    status,
    snapshot: Object.freeze({
      schemaVersion: 1,
      direction: direction(transaction.type),
      primaryAmount: Object.freeze({
        assetId,
        amountRaw: decimalToRaw(transaction.amount)
      }),
      ...(counterAmount ? { counterAmount } : {}),
      ...(transaction.from && !(transaction.type === 'send' && transaction.fromType === 'shielded')
        ? {
            sender: Object.freeze({
              chainId,
              address: transaction.from
            })
          }
        : {}),
      ...(finalRecipient
        ? { recipient: finalRecipient }
        : !crossChain && transaction.to
          ? {
              recipient: Object.freeze({
                chainId,
                address: transaction.to
              })
            }
          : {})
    }),
    segments,
    completeness: crossChain && !relayReference ? 'partial' : 'complete',
    createdAt: transaction.timestamp,
    updatedAt: transaction.timestamp,
    ...(failureCode ? { failureCode } : {})
  })
}
