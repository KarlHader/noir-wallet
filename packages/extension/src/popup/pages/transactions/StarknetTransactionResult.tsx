import { getStarknetNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { TransactionId } from '@/core/transactions/domain'
import {
  starknetWalletClient,
  type StarknetTransferSubmission
} from '@/popup/services/starknet-wallet-client'

import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'

export function StarknetTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: StarknetTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}) {
  const network = getStarknetNetworkConfig(DEFAULT_NETWORK)
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={starknetWalletClient}
      explorerBaseUrl={network.explorerUrl}
      explorerTransactionPath="tx"
      feeDecimals={18}
      feeSymbol="STRK"
      feeLabel="Max fee"
      totalLabel="Maximum total"
      showTotal={asset.metadata.symbol === 'STRK'}
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
