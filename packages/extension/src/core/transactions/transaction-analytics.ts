import { getQuantusChainId } from '@/core/chains/registry'
import {
  isBitcoinChainId,
  isDashChainId,
  isPearlChainId,
  isZcashChainId
} from '@/core/chains/registry/chain-ids'
import type { TransactionGraph } from './domain'

export type TransactionAnalyticsFamily =
  | 'zcash'
  | 'evm'
  | 'bitcoin'
  | 'dash'
  | 'pearl'
  | 'quantus'
  | 'solana'
  | 'near'

export function transactionAnalyticsFamily(chainId: string): TransactionAnalyticsFamily | null {
  if (chainId.startsWith('eip155:')) return 'evm'
  if (isDashChainId(chainId)) return 'dash'
  if (isPearlChainId(chainId)) return 'pearl'
  if (isZcashChainId(chainId)) return 'zcash'
  if (isBitcoinChainId(chainId)) return 'bitcoin'
  if (chainId === getQuantusChainId('mainnet') || chainId === getQuantusChainId('testnet')) {
    return 'quantus'
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
