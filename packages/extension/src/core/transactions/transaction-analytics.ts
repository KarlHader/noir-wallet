import type { TransactionAssetAmount, TransactionGraph } from './domain'
import { createAssetId, parseChainId } from '@/core/chains/registry'
import { getBundledInitialProductAssetDefinitions } from '@/core/chains/registry/product-chain-definitions'
import { formatUnits } from 'viem'

const BUNDLED_ASSETS = new Map(
  (['mainnet', 'testnet'] as const)
    .flatMap(network => getBundledInitialProductAssetDefinitions(network))
    .map(asset => [
      createAssetId(parseChainId(asset.chainId).id, asset.namespace, asset.reference),
      asset.metadata
    ])
)

export function transactionAnalyticsAssetMetadata(amount: TransactionAssetAmount | undefined) {
  return amount?.metadata ?? (amount ? BUNDLED_ASSETS.get(amount.assetId) : undefined)
}

export function transactionAnalyticsAssetAmount(
  amount: TransactionAssetAmount | undefined
): string | undefined {
  const metadata = transactionAnalyticsAssetMetadata(amount)
  if (!amount || !metadata || !/^[1-9]\d{0,77}$/.test(amount.amountRaw)) return undefined
  return formatUnits(BigInt(amount.amountRaw), metadata.decimals)
}

export function transactionAnalyticsInputMetadata(graph: TransactionGraph) {
  return transactionAnalyticsAssetMetadata(graph.root.intent?.primaryAmount)
}

export function transactionAnalyticsInputAmount(graph: TransactionGraph): string | undefined {
  return transactionAnalyticsAssetAmount(graph.root.intent?.primaryAmount)
}

export type TransactionAnalyticsFamily = 'evm' | 'bitcoin' | 'solana' | 'near'

export function transactionAnalyticsFamily(chainId: string): TransactionAnalyticsFamily | null {
  if (chainId.startsWith('eip155:')) return 'evm'
  if (chainId.startsWith('bip122:')) return 'bitcoin'
  if (chainId.startsWith('solana:')) return 'solana'
  if (chainId.startsWith('near:')) return 'near'
  return null
}

export function transactionBroadcasted(graph: TransactionGraph): boolean {
  const origin = graph.segments.find(segment => segment.role === 'origin')
  return Boolean(
    origin?.target?.kind === 'onchain' &&
    origin.evidence?.transactionHash &&
    (origin.status === 'broadcast' ||
      origin.status === 'confirming' ||
      origin.status === 'final') &&
    (graph.root.status === 'broadcast' ||
      graph.root.status === 'confirming' ||
      graph.root.status === 'final' ||
      graph.root.status === 'failed')
  )
}

export function transactionFailedBeforeBroadcast(graph: TransactionGraph): boolean {
  return (
    !transactionBroadcasted(graph) &&
    graph.root.status === 'failed' &&
    graph.root.failure?.code !== 'user-rejected' &&
    graph.root.failure?.code !== 'cancelled'
  )
}
