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

export interface MultichainConnectionAccountOption {
  readonly id: string
  readonly accountKey?: string
  readonly label: string
  readonly address: string
  readonly required?: boolean
}

export interface MultichainConnectionNetwork {
  readonly chainId: string
  readonly chainName: string
  readonly iconChain: string
}

export interface MultichainConnectionScope extends MultichainConnectionNetwork {
  readonly accounts: readonly MultichainConnectionAccountOption[]
  readonly preselectedIds: readonly string[]
  readonly networks?: readonly MultichainConnectionNetwork[]
}

export interface MultichainConnectionAccount {
  readonly key: string
  readonly label: string
  readonly permissions: readonly {
    readonly scope: MultichainConnectionScope
    readonly account: MultichainConnectionAccountOption
  }[]
  readonly networks: readonly MultichainConnectionNetwork[]
}

export function groupMultichainConnectionAccounts(
  scopes: readonly MultichainConnectionScope[]
): readonly MultichainConnectionAccount[] {
  const groups = new Map<string, MultichainConnectionAccount>()
  for (const scope of scopes) {
    for (const account of scope.accounts) {
      // Older pending requests without an identity must remain separate across scopes.
      const key = account.accountKey ?? JSON.stringify([scope.chainId, account.id])
      const previous = groups.get(key)
      const networks = new Map(
        [...(previous?.networks ?? []), ...(scope.networks ?? [scope])].map(network => [
          network.chainId,
          network
        ])
      )
      groups.set(key, {
        key,
        label: previous?.label ?? account.label,
        permissions: [...(previous?.permissions ?? []), { scope, account }],
        networks: [...networks.values()]
      })
    }
  }
  return [...groups.values()]
}

export function getMultichainConnectionAccountSelection(
  account: MultichainConnectionAccount,
  selections: Readonly<Record<string, readonly string[]>>
): 'none' | 'some' | 'all' {
  const count = account.permissions.filter(permission =>
    selections[permission.scope.chainId]?.includes(permission.account.id)
  ).length
  return count === 0 ? 'none' : count === account.permissions.length ? 'all' : 'some'
}

export function toggleMultichainConnectionAccount(
  account: MultichainConnectionAccount,
  selections: Readonly<Record<string, readonly string[]>>
): Record<string, string[]> {
  const select = getMultichainConnectionAccountSelection(account, selections) !== 'all'
  const next = Object.fromEntries(
    Object.entries(selections).map(([scope, ids]) => [scope, [...ids]])
  )
  for (const permission of account.permissions) {
    const { scope, account: option } = permission
    const ids = next[scope.chainId] ?? []
    next[scope.chainId] =
      select || option.required
        ? [...new Set([...ids, option.id])]
        : ids.filter(id => id !== option.id)
  }
  return next
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
