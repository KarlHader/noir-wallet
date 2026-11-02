import type {
  ConfidentialFundingPhase,
  ConfidentialFundingProgress
} from '@/core/services/confidential-funding'
import type { TransactionResultCopy, TransactionResultStatus } from '@/lib/transaction-status-copy'
import { getEvmNetworkConfigs } from '@/config/networks'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import { formatChainName, formatExplorerUrl, getChainFromAssetId } from '@/lib/format'
import type { Network } from '@/types'

export type ConfidentialFundingStatusView = ConfidentialFundingProgress &
  Readonly<{ phase: ConfidentialFundingPhase }>

export function getSwapTransactionReference(
  assetId: string | undefined,
  fallbackChain: string | undefined,
  hash: string,
  network: Network
): { readonly label: string; readonly url: string } {
  let chainId: string | undefined
  if (assetId) {
    try {
      chainId = parseAssetId(assetId).chainId
    } catch {
      try {
        chainId = parseChainId(assetId).id
      } catch {
        // Legacy Intents assets use protocol-specific identifiers.
      }
    }
  }
  const configuredChain = chainId
    ? getEvmNetworkConfigs(network).find(chain => chain.chainId === chainId)
    : undefined
  const legacyChain = getChainFromAssetId(assetId ?? '') || fallbackChain || ''
  const chainUrl = chainId ? formatChainTransactionExplorerUrl(chainId, hash, network) : ''
  const legacyUrl = formatExplorerUrl(legacyChain, hash)
  const fallbackUrl = fallbackChain ? formatExplorerUrl(fallbackChain, hash) : ''
  const useFallback =
    network === 'mainnet' &&
    chainId?.startsWith('rhea:') &&
    !chainUrl &&
    !legacyUrl &&
    Boolean(fallbackUrl)
  return {
    label: useFallback
      ? formatChainName(fallbackChain ?? legacyChain)
      : (configuredChain?.displayName ?? formatChainName(legacyChain)),
    url: chainUrl || legacyUrl || (useFallback ? fallbackUrl : '')
  }
}

export function getSwapResultAction(
  status: TransactionResultStatus,
  needsAuthorization: boolean,
  hasConfidentialFunding = false
): 'continue' | 'view-activity' | 'done' {
  if (needsAuthorization) return 'continue'
  return status === 'success' || (status === 'failed' && hasConfidentialFunding)
    ? 'done'
    : 'view-activity'
}

export function getSwapActionLabels(actionName?: string): {
  sendLabel: string
  receiveLabel: string
} {
  switch (actionName) {
    case 'Supply':
      return { sendLabel: 'Send', receiveLabel: 'Supplied' }
    case 'Withdraw':
      return { sendLabel: 'Withdraw', receiveLabel: 'Received' }
    case 'Claim':
      return { sendLabel: 'Claimed', receiveLabel: 'Received' }
    default:
      return { sendLabel: 'Send', receiveLabel: 'Receive' }
  }
}

export function getConfidentialFundingStatusCopy(
  funding: ConfidentialFundingStatusView,
  actionLabel: string
): TransactionResultCopy {
  return {
    title: funding.stage === 'ready' ? `${actionLabel} Ready` : funding.message,
    description:
      funding.phase === 'needs-auth'
        ? 'Confidential funding is paused until authorization is renewed.'
        : funding.stage === 'processing'
          ? `${funding.completed} of ${funding.total} transfers completed.`
          : funding.stage === 'ready'
            ? 'Confidential funds are ready.'
            : funding.phase === 'partial'
              ? 'Some transfers completed. Unsent funds remain in Confidential balance.'
              : funding.phase === 'refunded'
                ? 'Funds returned to Confidential balance.'
                : funding.stage === 'failed'
                  ? 'Confidential funding could not be completed.'
                  : 'Funds arrive privately in batches over about 10 minutes.',
    resultStatus:
      funding.stage === 'ready'
        ? 'success'
        : funding.stage === 'failed'
          ? funding.phase === 'partial' || funding.phase === 'refunded'
            ? 'warning'
            : 'failed'
          : 'loading'
  }
}
