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
  readonly account?: AccountRef | null
}

export function presentDAppPermissions(
  dapp: ConnectedDApp,
  { network, endpointSettings, account }: DAppPermissionContext
): readonly DAppPermissionPresentation[] {
  const evmNetworks = resolveEvmNetworkCatalog(network, endpointSettings)
  const chains = createInitialProductChainRegistry(
    network,
    evmNetworks.filter(config => config.source === 'custom')
  )
  const accountsByChain = new Map<string, Set<string>>()
  const addAccounts = (chainId: string, accounts: readonly AccountRef[]) => {
    const visibleAccounts =
      account === undefined
        ? accounts
        : accounts.filter(
            candidate =>
              account !== null &&
              candidate.walletId === account.walletId &&
              candidate.accountId === account.accountId
          )
    if (visibleAccounts.length === 0) return
    const uniqueAccounts = accountsByChain.get(chainId) ?? new Set<string>()
    for (const visibleAccount of visibleAccounts) {
      uniqueAccounts.add(JSON.stringify([visibleAccount.walletId, visibleAccount.accountId]))
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
    if (dapp.evmAuthorization && parseChainId(authorization.chainId).namespace === 'eip155') {
      continue
    }
    addAccounts(authorization.chainId, authorization.accounts)
  }
  if (dapp.evmAuthorization) {
    addAccounts('evm', dapp.evmAuthorization.accounts)
  }

  return [...accountsByChain].map(([chainId, accounts]) => {
    if (chainId === 'evm') {
      return { chainId, label: 'EVM', iconChain: 'evm', accountCount: accounts.size }
    }
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
