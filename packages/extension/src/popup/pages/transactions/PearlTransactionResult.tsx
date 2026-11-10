import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  pearlWalletClient,
  type PearlTransferSubmission
} from '@/popup/services/pearl-wallet-client'
import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'
import { resolveChainExplorerTarget } from '@/popup/services/chain-explorer'
import type { TransactionId } from '@/core/transactions/domain'

interface PearlTransactionResultProps {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: PearlTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}

export function PearlTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: PearlTransactionResultProps) {
  const explorer = resolveChainExplorerTarget(chain.chain.id, DEFAULT_NETWORK)
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={pearlWalletClient}
      explorerBaseUrl={explorer?.baseUrl ?? ''}
      explorerTransactionPath={explorer?.transactionPath}
      feeDecimals={8}
      feeSymbol="PRL"
      feeLabel="Network fee"
      totalLabel="Total"
      showTotal
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
