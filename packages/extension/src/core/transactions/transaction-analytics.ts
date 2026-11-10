import { getBitcoinChainId, getPearlChainId } from '@/core/chains/registry'
import type { TransactionGraph } from './domain'

export type TransactionAnalyticsFamily = 'evm' | 'bitcoin' | 'pearl' | 'solana' | 'near'

export function transactionAnalyticsFamily(chainId: string): TransactionAnalyticsFamily | null {
  if (chainId.startsWith('eip155:')) return 'evm'
  if (chainId === getPearlChainId('mainnet') || chainId === getPearlChainId('testnet')) {
    return 'pearl'
  }
  if (
    chainId === getBitcoinChainId('mainnet') ||
    chainId === getBitcoinChainId('testnet') ||
    chainId.startsWith('bip122:')
  ) {
    return 'bitcoin'
  }
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
