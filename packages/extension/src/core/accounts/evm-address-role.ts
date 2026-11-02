export type EvmAddressRole = 'public' | 'confidential' | 'unknown'

interface LocalAccountAddresses {
  readonly networks: readonly {
    readonly chain: { readonly id: string }
    readonly addresses: readonly { readonly value: string }[]
    readonly privateExecutionAddress?: string
  }[]
}

/** Only the local account directory establishes an address's role. */
export function resolveEvmAddressRole(
  address: string,
  chainId: string,
  accounts: readonly LocalAccountAddresses[] = []
): EvmAddressRole {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) return 'unknown'
  const normalized = address.toLowerCase()
  const networks = accounts.flatMap(account =>
    account.networks.filter(network => network.chain.id === chainId)
  )
  if (networks.some(network => network.privateExecutionAddress?.toLowerCase() === normalized))
    return 'confidential'
  return networks.some(network =>
    network.addresses.some(candidate => candidate.value.toLowerCase() === normalized)
  )
    ? 'public'
    : 'unknown'
}
