import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  bitcoinWalletClient,
  type BitcoinTransferSubmission
} from '@/popup/services/bitcoin-wallet-client'
import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'
import type { TransactionId } from '@/core/transactions/domain'

interface BitcoinTransactionResultProps {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: BitcoinTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}

export function BitcoinTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: BitcoinTransactionResultProps) {
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={bitcoinWalletClient}
      feeDecimals={8}
      feeSymbol="BTC"
      feeLabel="Network fee"
      totalLabel="Total"
      showTotal
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
