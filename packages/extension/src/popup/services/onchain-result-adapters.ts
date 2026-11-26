import type { PortfolioChainView } from '@/core/portfolio'
import type { TransactionGraph, TransactionId } from '@/core/transactions/domain'
import { bitcoinWalletClient } from './bitcoin-wallet-client'
import { evmWalletClient } from './evm-wallet-client'
import { nearWalletClient } from './near-wallet-client'
import type { OnchainTransferActivity } from './onchain-transfer-activity'
import { solanaWalletClient } from './solana-wallet-client'

export interface OnchainTransferSubmission {
  readonly status: 'broadcast' | 'signed-pending-broadcast'
  readonly graph: TransactionGraph
}

interface OnchainResultAdapter {
  readonly client: {
    readonly getTransferActivity: (
      graph: TransactionGraph
    ) => Promise<OnchainTransferActivity | null>
    readonly resumeTransfer: (transactionId: TransactionId) => Promise<OnchainTransferSubmission>
  }
  readonly feeDecimals: number
  readonly feeSymbol: string
  readonly feeLabel?: string
  readonly totalLabel?: string
  readonly resolveFeeSymbol?: (chain: PortfolioChainView) => string | undefined
}

const adapters = {
  bitcoin: { client: bitcoinWalletClient, feeDecimals: 8, feeSymbol: 'BTC' },
  evm: {
    client: evmWalletClient,
    feeDecimals: 18,
    feeSymbol: 'ETH',
    feeLabel: 'Max network fee',
    totalLabel: 'Maximum total',
    resolveFeeSymbol: chain =>
      chain.assets.find(entry => entry.asset.kind === 'native')?.metadata.symbol
  },
  near: {
    client: nearWalletClient,
    feeDecimals: 24,
    feeSymbol: 'NEAR',
    totalLabel: 'Maximum total'
  },
  solana: { client: solanaWalletClient, feeDecimals: 9, feeSymbol: 'SOL' }
} satisfies Record<string, OnchainResultAdapter>

export type OnchainResultFamily = keyof typeof adapters

export function getOnchainResultAdapter(family: OnchainResultFamily, chain: PortfolioChainView) {
  const adapter: OnchainResultAdapter = adapters[family]
  return {
    client: adapter.client,
    feeDecimals: adapter.feeDecimals,
    feeSymbol: adapter.resolveFeeSymbol?.(chain) ?? adapter.feeSymbol,
    feeLabel: adapter.feeLabel ?? 'Network fee',
    totalLabel: adapter.totalLabel ?? 'Total'
  }
}
