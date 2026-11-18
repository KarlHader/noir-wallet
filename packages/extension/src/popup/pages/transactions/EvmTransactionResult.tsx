import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { evmWalletClient, type EvmTransferSubmission } from '@/popup/services/evm-wallet-client'
import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'
import type { TransactionId } from '@/core/transactions/domain'

interface EvmTransactionResultProps {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: EvmTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}

export function EvmTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: EvmTransactionResultProps) {
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={evmWalletClient}
      feeDecimals={18}
      feeSymbol={
        chain.assets.find(entry => entry.asset.kind === 'native')?.metadata.symbol ?? 'ETH'
      }
      feeLabel="Max fee"
      totalLabel="Maximum total"
      showTotal={asset.asset.kind === 'native'}
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
