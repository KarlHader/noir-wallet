const PREFERRED_CHAINS = [
  ['zcash', 'zec'],
  ['eip155:1', 'eth', 'ethereum'],
  ['eip155:56', 'bsc'],
  ['eip155:8453', 'base'],
  ['eip155:42161', 'arb', 'arbitrum'],
  ['eip155:137', 'pol', 'polygon']
] as const

function networkRank(network: Readonly<{ id: string; name: string }>): number {
  const id = network.id.toLowerCase()
  const name = network.name.toLowerCase()
  if (id === 'all' || id === 'evm:all') return -1
  const idRank = PREFERRED_CHAINS.findIndex(aliases => aliases.some(alias => alias === id))
  if (idRank !== -1) return idRank
  if (name.startsWith('zcash')) return 0
  if (name.startsWith('ethereum')) return 1
  if (name.startsWith('bnb chain') || name.startsWith('bnb smart chain') || name.startsWith('bsc'))
    return 2
  if (name.startsWith('base')) return 3
  if (name.startsWith('arbitrum')) return 4
  if (name.startsWith('polygon')) return 5
  return PREFERRED_CHAINS.length
}

/** Keeps the preferred wallet networks first and every other network in source order. */
export function sortTokenSelectorNetworks<T>(
  options: readonly T[],
  network: (option: T) => Readonly<{ id: string; name: string }>
): T[] {
  return [...options].sort(
    (left, right) => networkRank(network(left)) - networkRank(network(right))
  )
}
