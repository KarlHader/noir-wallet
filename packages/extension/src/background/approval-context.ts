import type { FeeQuote } from '@/config/fee'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import { dappManager } from '@/core/dapp/dapp-manager'
import { getWorkerClient } from '@/core/worker/client'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { safeBig } from '@/lib/big'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { pendingRequestsManager, type PendingRequest } from './pending-requests'
import { approvalContextMatches } from './approval-context-policy'
import { credentialSession } from './credential-session'
import { capturePublicEvmContext } from './noir-protocol/public-context'

const ZCASH_ACTIONS = new Set([
  'connect',
  'sendTransaction',
  'signMessage',
  'shieldFunds',
  'publicActivate',
  'publicTransaction'
])

export async function getApprovalContext(requestId: string): Promise<PendingRequest> {
  const request = pendingRequestsManager.get(requestId)
  if (!request) throw new Error('Request not found or expired')
  if (!ZCASH_ACTIONS.has(request.action)) return request

  if (
    (request.action === 'publicActivate' || request.action === 'publicTransaction') &&
    request.data?.account?.chain === 'evm'
  ) {
    try {
      const context = await capturePublicEvmContext(request.origin, request.data.chainId)
      if (
        context.evmAddress !== request.data.account.publicKey ||
        context.executionModeRevision !== request.data.executionModeRevision ||
        context.authorizationRevision !== request.authorizationRevision ||
        pendingRequestsManager.get(requestId) !== request
      )
        throw new Error('Public EVM approval context changed')
      return request
    } catch {
      pendingRequestsManager.cancel(requestId)
      throw new Error('EVM account or site connection changed. Reconnect and try again.')
    }
  }

  await rehydrateWalletStore()
  const authorization = await dappManager.getAuthorization(request.origin)
  const isPublic = request.action === 'publicActivate' || request.action === 'publicTransaction'
  const publicLocked = isPublic && !(await credentialSession.hasUnlockSession())
  const state = useWalletStore.getState()
  const wallet = state.getWallet(request.walletId)
  const internalPublicActivation =
    request.action === 'publicActivate' &&
    request.origin === `chrome-extension://${chrome.runtime.id}`
  const accountAuthorized =
    internalPublicActivation ||
    authorization.accounts.some(
      account => account.walletId === request.walletId && account.accountId === request.accountId
    )
  if (
    !approvalContextMatches({
      action: request.action,
      requestNetwork: request.network,
      currentNetwork: state.currentNetwork,
      requestWalletId: request.walletId,
      requestAccountId: request.accountId,
      currentWalletId: state.currentWalletId,
      currentAccountId: state.currentAccountId,
      accountExists: !!state.getAccount(request.walletId, request.accountId),
      locked: isPublic
        ? publicLocked
        : !isZcashHardwareKeySource(wallet?.keySource) && backgroundZcashWalletRuntime.isLocked(),
      authorizationRevision: request.authorizationRevision,
      currentAuthorizationRevision: authorization.revision,
      accountAuthorized,
      requestStillPending: pendingRequestsManager.get(requestId) === request
    })
  ) {
    pendingRequestsManager.cancel(requestId)
    throw new Error('Wallet account or site connection changed. Reconnect and try again.')
  }
  return request
}

export async function estimateApprovalFee(
  requestId: string,
  selection: { marginalFeeZats?: number; feeQuoteId?: string; feeTier?: unknown } = {}
): Promise<{ fee: string; marginalFeeZats: string; feeQuote: FeeQuote }> {
  const request = await getApprovalContext(requestId)
  if (request.action !== 'shieldFunds' && request.action !== 'sendTransaction') {
    throw new Error('Request does not support fee estimation')
  }
  await backgroundZcashWalletRuntime.getWalletCore(request.walletId, request.accountId)
  await getApprovalContext(requestId)
  const account = useWalletStore.getState().getAccount(request.walletId, request.accountId)
  if (!account) throw new Error('Account is no longer available')
  const client = getWorkerClient(request.walletId)
  if (
    selection.feeTier !== undefined &&
    selection.feeTier !== 'standard' &&
    selection.feeTier !== 'fast'
  ) {
    throw new Error('Invalid network fee tier')
  }
  const quote =
    selection.feeQuoteId === undefined
      ? await client.getFeeQuote(undefined, account.derivationIndex)
      : undefined
  const marginalFeeZats = quote
    ? marginalFeeForTier(selection.feeTier ?? 'standard', quote.standardMarginalFeeZats)
    : selection.marginalFeeZats
  const feeQuoteId = quote?.id ?? selection.feeQuoteId
  const fee =
    request.action === 'shieldFunds'
      ? await client.estimateShieldFee({
          accountIndex: account.derivationIndex,
          marginalFeeZats,
          feeQuoteId
        })
      : await client.estimateTransferFee({
          accountIndex: account.derivationIndex,
          to: request.data.to,
          value: safeBig(request.data.amount).times(1e8).toFixed(0),
          memo: request.data.memo,
          marginalFeeZats,
          feeQuoteId,
          fundingSource: request.data.fundingSource ?? 'shielded'
        })
  await getApprovalContext(requestId)
  return { fee: fee.feeZats, marginalFeeZats: fee.marginalFeeZats, feeQuote: fee.feeQuote }
}
