import { resolveChainIconAlias } from '@/lib/chain-icon'
import type {
  AccountNetworkAddressView,
  AccountNetworkView
} from '@/popup/services/account-networks-client'

export function accountNetworkLabel(network: AccountNetworkView): string {
  if (network.chain.family === 'zcash') return 'Zcash'
  if (network.chain.family === 'bitcoin') return 'Bitcoin'
  if (network.chain.family === 'pearl') return 'Pearl'
  return network.chain.displayName
}

export function accountNetworkIconChain(network: AccountNetworkView): string {
  return resolveChainIconAlias(network.chain.family, network.chain.displayName)
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
  if (network.chain.family === 'pearl') {
    return 'Taproot'
  }
  if (address.privacy === 'shielded') return 'shielded'
  if (address.privacy === 'transparent') return 'transparent'
  return 'mixed'
}
