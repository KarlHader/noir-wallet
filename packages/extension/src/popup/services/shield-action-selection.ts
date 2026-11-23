import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import type { Network } from '@/types/wallet'
import type { AccountNetworksView } from './account-networks-client'
import { summarizeNearConfidentialHoldings } from './near-confidential-holdings'
import { getPrivateTransferChainIds } from './private-balance-transfer'
import type { ShieldProvider } from './asset-domains'

export const SHIELD_ACTIONS = [
  { action: 'send', label: 'Send' },
  { action: 'receive', label: 'Receive' },
  { action: 'swap', label: 'Swap' }
] as const

type ShieldAction = (typeof SHIELD_ACTIONS)[number]['action']

export function buildShieldActionPath(
  action: ShieldAction,
  options: {
    readonly provider?: ShieldProvider
    readonly assetId?: string | null
    readonly account?: { readonly walletId: string; readonly accountId: string } | null
    readonly originPath?: string
  } = {}
): string {
  const { provider, assetId, account, originPath } = options
  const query = new URLSearchParams()
  if (provider) query.set('provider', provider)
  if (assetId) query.set(action === 'swap' ? 'source' : 'assetId', assetId)
  if (account) {
    query.set(action === 'receive' ? 'walletId' : 'sourceWalletId', account.walletId)
    query.set(action === 'receive' ? 'accountId' : 'sourceAccountId', account.accountId)
  }
  if (action === 'receive') {
    query.set('mode', 'shield')
    return `/receive?${query}`
  }
  if (action === 'send') {
    query.set('sourceMode', 'shield')
    if (originPath) query.set('originPath', originPath)
    return `/send?${query}`
  }
  query.set('balanceDomain', 'shield')
  if (provider === 'zcash-shield') query.set('shieldZecSource', 'native')
  return `/swap?${query}`
}

export function selectShieldActions(input: {
  readonly model: PortfolioReadModel | null
  readonly prices: AssetPriceReadModel | null
  readonly account: AccountNetworksView | null
  readonly network: Network
}) {
  const { model, prices, account, network } = input
  const near = summarizeNearConfidentialHoldings(model, prices)
  const canManageNear = getPrivateTransferChainIds(account, network === 'mainnet').length > 0
  const hasZcash = account?.networks.some(item => item.chain.family === 'zcash') ?? false
  const providersFor = (action: ShieldAction): readonly ShieldProvider[] => {
    const nearAvailable = canManageNear
    const zcashAvailable = action !== 'swap' && hasZcash
    return [
      ...(nearAvailable ? (['near-confidential'] as const) : []),
      ...(zcashAvailable ? (['zcash-shield'] as const) : [])
    ]
  }
  return {
    near,
    canManageNear,
    hasZcash,
    providersFor
  }
}
