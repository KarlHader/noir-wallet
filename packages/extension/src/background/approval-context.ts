import { MARGINAL_FEE_ZATS } from '@/config/fee'
import { dappManager } from '@/core/dapp/dapp-manager'
import { getWorkerClient } from '@/core/worker/client'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { safeBig } from '@/lib/big'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { pendingRequestsManager, type PendingRequest } from './pending-requests'
import { approvalContextMatches } from './approval-context-policy'
import { credentialSession } from './credential-session'

const ZCASH_ACTIONS = new Set([
  'connect',
  'sendTransaction',
  'signMessage',
  'shieldFunds',
  'publicConnect',
  'publicSignMessage',
  'publicActivate',
  'publicTransaction'
])

export async function getApprovalContext(requestId: string): Promise<PendingRequest> {
  const request = pendingRequestsManager.get(requestId)
  if (!request) throw new Error('Request not found or expired')
  if (!ZCASH_ACTIONS.has(request.action)) return request

  await rehydrateWalletStore()
  const authorization = await dappManager.getAuthorization(request.origin)
  const publicAuthorization = await dappManager.getPublicAuthorization(request.origin)
  const isPublic = [
    'publicConnect',
    'publicActivate',
    'publicTransaction',
    'publicSignMessage'
  ].includes(request.action)
  const publicLocked = isPublic && !(await credentialSession.hasUnlockSession())
  const state = useWalletStore.getState()
  const wallet = state.getWallet(request.walletId)
  const internalPublicActivation =
    request.action === 'publicActivate' &&
    request.origin === `chrome-extension://${chrome.runtime.id}`
  const accountAuthorized =
    internalPublicActivation ||
    (isPublic
      ? publicAuthorization.binding?.walletId === request.walletId &&
        publicAuthorization.binding.accountId === request.accountId
      : authorization.accounts.some(
          account =>
            account.walletId === request.walletId && account.accountId === request.accountId
        ))
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
      currentAuthorizationRevision: isPublic
        ? publicAuthorization.revision
        : authorization.revision,
      accountAuthorized,
      requestStillPending: pendingRequestsManager.get(requestId) === request
    })
  ) {
    pendingRequestsManager.cancel(requestId)
    throw new Error('Wallet account or site connection changed. Reconnect and try again.')
  }
  return request
}

export async function estimateApprovalFee(requestId: string): Promise<string> {
  const request = await getApprovalContext(requestId)
  if (request.action !== 'shieldFunds' && request.action !== 'sendTransaction') {
    throw new Error('Request does not support fee estimation')
  }
  await backgroundZcashWalletRuntime.getWalletCore(request.walletId, request.accountId)
  await getApprovalContext(requestId)
  const account = useWalletStore.getState().getAccount(request.walletId, request.accountId)
  if (!account) throw new Error('Account is no longer available')
  const client = getWorkerClient(request.walletId)
  const fee =
    request.action === 'shieldFunds'
      ? await client.estimateShieldFee({
          accountIndex: account.derivationIndex,
          marginalFeeZats: MARGINAL_FEE_ZATS.standard
        })
      : (
          await client.estimateTransferFee({
            accountIndex: account.derivationIndex,
            to: request.data.to,
            value: safeBig(request.data.amount).times(1e8).toFixed(0),
            memo: request.data.memo,
            marginalFeeZats: MARGINAL_FEE_ZATS.standard,
            fundingSource: request.data.fundingSource ?? 'shielded'
          })
        ).feeZats
  await getApprovalContext(requestId)
  return fee
}
