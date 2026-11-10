import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { TransactionId } from '@/core/transactions/domain'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { dashWalletClient, type DashTransferSubmission } from '@/popup/services/dash-wallet-client'
import { resolveChainExplorerTarget } from '@/popup/services/chain-explorer'
import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'

export function DashTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: DashTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}) {
  const explorer = resolveChainExplorerTarget(chain.chain.id, DEFAULT_NETWORK)
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={dashWalletClient}
      explorerBaseUrl={explorer?.baseUrl ?? ''}
      explorerTransactionPath={explorer?.transactionPath}
      feeDecimals={8}
      feeSymbol="DASH"
      feeLabel="Network fee"
      totalLabel="Total"
      showTotal
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
