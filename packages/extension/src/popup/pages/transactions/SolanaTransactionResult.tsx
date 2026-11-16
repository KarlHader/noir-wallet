import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  solanaWalletClient,
  type SolanaTransferSubmission
} from '@/popup/services/solana-wallet-client'
import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'
import type { TransactionId } from '@/core/transactions/domain'

export function SolanaTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: SolanaTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}) {
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={solanaWalletClient}
      feeDecimals={9}
      feeSymbol="SOL"
      feeLabel="Network fee"
      totalLabel="Total"
      showTotal={asset.asset.kind === 'native'}
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
