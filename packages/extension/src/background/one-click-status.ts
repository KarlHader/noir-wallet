import { getConfidentialFundingNetworkConfig } from '@/config/intents'
import type { OneClickOrder } from '@/core/services/near-intents/one-click-order'
import {
  OneClickStatusClient,
  type OneClickAccount
} from '@/core/services/near-intents/one-click-status-client'
import { loadOneClickWallet, resolveOneClickSigner } from './one-click-status-signing'
import { oneClickStatusTokens } from './one-click-status-tokens'

export { resolveZcashOneClickViewer } from './one-click-status-signing'

const client = new OneClickStatusClient({
  tokens: oneClickStatusTokens,
  resolveSigner: resolveOneClickSigner
})

export async function queryOneClickOrderStatus(
  input: OneClickAccount & {
    readonly order: OneClickOrder
    readonly signal?: AbortSignal
  }
): Promise<unknown | null> {
  const { network, walletId, accountId, order, signal } = input
  const config = getConfidentialFundingNetworkConfig(network)
  if (!config || !order.viewer || !(await loadOneClickWallet(input))) return null
  return client.query(
    { network, walletId, accountId, endpoint: config.oneClickApiUrl, viewer: order.viewer },
    order,
    signal
  )
}
