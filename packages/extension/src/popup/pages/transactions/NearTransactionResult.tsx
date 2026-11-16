import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { nearWalletClient, type NearTransferSubmission } from '@/popup/services/near-wallet-client'

import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'
import type { TransactionId } from '@/core/transactions/domain'

export function NearTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: NearTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}) {
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={nearWalletClient}
      feeDecimals={24}
      feeSymbol="NEAR"
      feeLabel="Network fee"
      totalLabel="Maximum total"
      showTotal={asset.asset.kind === 'native'}
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
