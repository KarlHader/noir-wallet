import type {
  AccountNetworkAddressView,
  AccountNetworkView
} from '@/popup/services/account-networks-client'

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
          displayName:
            network.chain.family === 'zcash'
              ? 'Zcash'
              : network.chain.family === 'bitcoin'
                ? 'Bitcoin'
                : network.chain.displayName,
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
