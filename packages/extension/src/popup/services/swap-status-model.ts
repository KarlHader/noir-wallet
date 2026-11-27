import type {
  ConfidentialFundingPhase,
  ConfidentialFundingProgress
} from '@/core/services/confidential-funding'
import type { TransactionResultCopy, TransactionResultStatus } from '@/lib/transaction-status-copy'
import {
  getKnownEvmNetworkIdentities,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import {
  getBitcoinChainId,
  getZcashChainId,
  parseAssetId,
  parseChainId
} from '@/core/chains/registry'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import { formatChainName, formatExplorerUrl, getChainFromAssetId } from '@/lib/format'
import type { Network } from '@/types'

export type ConfidentialFundingStatusView = ConfidentialFundingProgress &
  Readonly<{ phase: ConfidentialFundingPhase }>

function getNativeExplorerChainId(alias: string, network: Network): string | undefined {
  switch (alias) {
    case 'zec':
    case 'zcash':
      return getZcashChainId(network)
    case 'btc':
    case 'bitcoin':
      return getBitcoinChainId(network)
    case 'sol':
    case 'solana':
      return getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId
    case 'near':
      return getNearNetworkConfig(network).chainId
  }
}

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
  const inferredChain = getChainFromAssetId(assetId ?? '').toLowerCase()
  const normalizedHint = fallbackChain?.trim().toLowerCase()
  const legacyChain =
    assetId?.startsWith('nep141:') && inferredChain === 'near' && normalizedHint
      ? normalizedHint
      : inferredChain || normalizedHint || ''
  const rheaHint =
    network === 'mainnet' && chainId?.startsWith('rhea:') ? normalizedHint : undefined
  const configuredChain = getKnownEvmNetworkIdentities(network).find(chain =>
    chainId && !rheaHint ? chain.chainId === chainId : chain.iconChain === (rheaHint ?? legacyChain)
  )
  const nativeChainId =
    !chainId || rheaHint ? getNativeExplorerChainId(rheaHint ?? legacyChain, network) : undefined
  const resolvedChainId = configuredChain?.chainId ?? nativeChainId ?? chainId
  const chainUrl = resolvedChainId
    ? formatChainTransactionExplorerUrl(resolvedChainId, hash, network)
    : ''
  const legacyUrl =
    !resolvedChainId && network === 'mainnet' ? formatExplorerUrl(legacyChain, hash) : ''
  return {
    label:
      configuredChain?.displayName ??
      formatChainName(rheaHint && chainUrl ? rheaHint : legacyChain),
    url: chainUrl || legacyUrl
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
              ? 'Some transfers completed.'
              : funding.phase === 'refunded'
                ? 'The transfer was refunded.'
                : funding.stage === 'failed'
                  ? 'Confidential funding could not be completed.'
                  : 'Preparing your transfer.',
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
