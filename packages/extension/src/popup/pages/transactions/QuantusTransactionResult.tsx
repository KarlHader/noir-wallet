import { getQuantusNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import {
  quantusWalletClient,
  type QuantusTransferSubmission
} from '@/popup/services/quantus-wallet-client'
import type { TransactionId } from '@/core/transactions/domain'

import { OnchainTransactionResult, type OnchainResultOutcome } from './OnchainTransactionResult'

/**
 * Quantus has no supplemental indexer, so the wallet's own persisted
 * transaction graph is the only Activity source for this result page.
 */
export function QuantusTransactionResult({
  asset,
  chain,
  submission,
  onDone,
  onViewActivity
}: {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
  readonly submission: QuantusTransferSubmission
  readonly onDone: (outcome: OnchainResultOutcome) => void
  readonly onViewActivity: (transactionId: TransactionId) => void
}) {
  const network = getQuantusNetworkConfig(DEFAULT_NETWORK)
  return (
    <OnchainTransactionResult
      asset={asset}
      chain={chain}
      submission={submission}
      client={quantusWalletClient}
      explorerBaseUrl={network.explorerUrl}
      explorerTransactionPath="extrinsic"
      feeDecimals={network.nativeCurrency.decimals}
      feeSymbol={network.nativeCurrency.symbol}
      feeLabel="Network fee (max)"
      totalLabel="Maximum total"
      showTotal
      onDone={onDone}
      onViewActivity={onViewActivity}
    />
  )
}
