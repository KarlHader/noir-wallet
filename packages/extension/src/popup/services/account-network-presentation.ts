import { resolveChainIconAlias } from '@/lib/chain-icon'
import { resolveEvmChainIconAlias } from '@/config/icons'
import type {
  AccountNetworkAddressView,
  AccountNetworkView
} from '@/popup/services/account-networks-client'

export function accountNetworkLabel(network: AccountNetworkView): string {
  if (network.chain.family === 'zcash') return 'Zcash'
  if (network.chain.family === 'bitcoin') return 'Bitcoin'
  return network.chain.displayName
}

export function accountNetworkIconChain(network: AccountNetworkView): string {
  if (network.chain.family === 'evm') return resolveEvmChainIconAlias(network.chain.id)
  return resolveChainIconAlias(network.chain.family, network.chain.displayName)
}

export function zcashSettingsPath(walletId: string, accountId: string): string {
  return `/zcash-settings?${new URLSearchParams({ walletId, accountId })}`
}

export function addIncognitoNetworkPath(walletId: string, accountId: string): string {
  return `/account-networks?${new URLSearchParams({ walletId, accountId, add: 'evm' })}`
}

export function evmExecutionAddresses(networks: readonly AccountNetworkView[]): {
  readonly mainAddress?: string
  readonly privateAddress?: string
} {
  const network =
    networks.find(entry => entry.chain.family === 'evm' && entry.privateExecutionAddress) ??
    networks.find(entry => entry.chain.family === 'evm')
  if (!network) return {}
  const mainAddress =
    network.addresses.find(address => address.preferredForReceive)?.value ??
    network.addresses[0]?.value
  return {
    ...(mainAddress ? { mainAddress } : {}),
    ...(network.privateExecutionAddress ? { privateAddress: network.privateExecutionAddress } : {})
  }
}

export function accountNetworkAddressLabel(
  network: AccountNetworkView,
  address: AccountNetworkAddressView
): string {
  if (network.chain.family === 'bitcoin') {
    switch (address.scheme) {
      case 'bitcoin-p2pkh':
        return 'Legacy'
      case 'bitcoin-p2sh-p2wpkh':
        return 'Nested SegWit'
      case 'bitcoin-p2wpkh':
        return 'Native SegWit'
      case 'bitcoin-p2tr':
        return 'Taproot'
    }
  }
  if (address.privacy === 'shielded') return 'shielded'
  if (address.privacy === 'transparent') return 'transparent'
  return 'mixed'
}

export interface AccountNetworkDisplayGroup {
  readonly id: string
  readonly family: string
  readonly displayName: string
  readonly networks: readonly AccountNetworkView[]
  readonly addresses: readonly AccountNetworkAddressView[]
}

function evmAddressKey(network: AccountNetworkView): string {
  return network.addresses
    .map(address => address.value.toLowerCase())
    .sort()
    .join(':')
}

export function groupAccountNetworksForDisplay(
  networks: readonly AccountNetworkView[]
): readonly AccountNetworkDisplayGroup[] {
  const groups: AccountNetworkDisplayGroup[] = []
  const evmGroups = new Map<string, AccountNetworkDisplayGroup>()

  for (const network of networks) {
    if (network.chain.family !== 'evm') {
      groups.push(
        Object.freeze({
          id: network.chain.id,
          family: network.chain.family,
          displayName: accountNetworkLabel(network),
          networks: Object.freeze([network]),
          addresses: network.addresses
        })
      )
      continue
    }

    const key = evmAddressKey(network)
    const existing = evmGroups.get(key)
    if (existing) {
      const merged = Object.freeze({
        ...existing,
        networks: Object.freeze([...existing.networks, network])
      })
      evmGroups.set(key, merged)
      groups[groups.indexOf(existing)] = merged
      continue
    }

    const group = Object.freeze({
      id: `evm:${key}`,
      family: 'evm',
      displayName: 'EVM',
      networks: Object.freeze([network]),
      addresses: network.addresses
    })
    evmGroups.set(key, group)
    groups.push(group)
  }

  return Object.freeze(groups)
}
