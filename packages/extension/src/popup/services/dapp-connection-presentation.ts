import { resolveEvmChainIconAlias } from '@/config/icons'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import {
  createInitialProductChainRegistry,
  getZcashChainId,
  parseChainId
} from '@/core/chains/registry'
import type { AccountRef, ConnectedDApp } from '@/core/dapp/dapp-manager'
import type { Network } from '@/types'

export interface DAppPermissionPresentation {
  readonly chainId: string
  readonly label: string
  readonly iconChain: string
  readonly accountCount: number
}

interface DAppPermissionContext {
  readonly network: Network
  readonly endpointSettings: ChainEndpointSettings
}

export function presentDAppPermissions(
  dapp: ConnectedDApp,
  { network, endpointSettings }: DAppPermissionContext
): readonly DAppPermissionPresentation[] {
  const evmNetworks = resolveEvmNetworkCatalog(network, endpointSettings)
  const chains = createInitialProductChainRegistry(
    network,
    evmNetworks.filter(config => config.source === 'custom')
  )
  const accountsByChain = new Map<string, Set<string>>()
  const addAccounts = (chainId: string, accounts: readonly AccountRef[]) => {
    if (accounts.length === 0) return
    const uniqueAccounts = accountsByChain.get(chainId) ?? new Set<string>()
    for (const account of accounts) {
      uniqueAccounts.add(JSON.stringify([account.walletId, account.accountId]))
    }
    accountsByChain.set(chainId, uniqueAccounts)
  }

  if (dapp.authorizedAccounts?.length) {
    addAccounts(getZcashChainId(network), dapp.authorizedAccounts)
  } else if (dapp.boundWalletId && dapp.boundAccountId) {
    addAccounts(getZcashChainId(network), [
      { walletId: dapp.boundWalletId, accountId: dapp.boundAccountId }
    ])
  }

  for (const authorization of dapp.chainAuthorizations ?? []) {
    addAccounts(authorization.chainId, authorization.accounts)
  }

  return [...accountsByChain].map(([chainId, accounts]) => {
    const parsed = parseChainId(chainId)
    const chain = chains.get(parsed.id)
    return {
      chainId,
      label:
        chain?.displayName ?? (parsed.namespace === 'eip155' ? `EVM ${parsed.reference}` : chainId),
      iconChain:
        parsed.namespace === 'eip155'
          ? resolveEvmChainIconAlias(chainId)
          : (chain?.family ?? 'custom-evm'),
      accountCount: accounts.size
    }
  })
}
