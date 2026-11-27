import { getConfidentialFundingNetworkConfig } from '@/config/intents'
import type { OneClickOrder, OneClickViewer } from '@/core/services/near-intents/one-click-order'
import {
  OneClickStatusClient,
  type OneClickAccount,
  type OneClickChallenge
} from '@/core/services/near-intents/one-click-status-client'
import { hasOneClickWalletAccount, resolveOneClickSigner } from './one-click-status-signing'
import { oneClickStatusTokens } from './one-click-status-tokens'

export { resolveZcashOneClickViewer } from './one-click-status-signing'

const client = new OneClickStatusClient({
  tokens: oneClickStatusTokens,
  resolveSigner: resolveOneClickSigner
})

export async function authorizeOneClickOrderOwner(
  scope: OneClickAccount & { readonly viewer: OneClickViewer },
  sign: (challenge: OneClickChallenge) => Promise<Record<string, string>>
): Promise<void> {
  const config = getConfidentialFundingNetworkConfig(scope.network)
  if (
    !config ||
    !(await hasOneClickWalletAccount(scope)) ||
    !(await client.authorizeOwner({ ...scope, endpoint: config.oneClickApiUrl }, sign))
  ) {
    throw new Error('Could not authorize access to the Confidential order.')
  }
}

export async function queryOneClickOrderStatus(
  input: OneClickAccount & {
    readonly order: OneClickOrder
    readonly signal?: AbortSignal
  }
): Promise<unknown | null> {
  const { network, walletId, accountId, order, signal } = input
  const config = getConfidentialFundingNetworkConfig(network)
  if (!config || !order.viewer || !(await hasOneClickWalletAccount(input))) return null
  return client.query(
    { network, walletId, accountId, endpoint: config.oneClickApiUrl, viewer: order.viewer },
    order,
    signal
  )
}
