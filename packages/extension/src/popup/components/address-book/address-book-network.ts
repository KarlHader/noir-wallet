import { findBuiltinEvmNetworkConfig } from '@/config/networks'
import { getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { AddressBookContact } from '@/core/address-book/address-book'

export interface AddressBookNetworkChoice {
  readonly chainId: string
  readonly name: string
  readonly family: AddressBookContact['chainFamily']
}

export function getAddressBookNetworkChoice(chainId: string): AddressBookNetworkChoice | null {
  if (chainId === getZcashChainId(DEFAULT_NETWORK)) {
    return {
      chainId,
      name: DEFAULT_NETWORK === 'mainnet' ? 'Zcash' : 'Zcash Testnet',
      family: 'zcash'
    }
  }
  if (chainId === getBitcoinChainId(DEFAULT_NETWORK)) {
    return {
      chainId,
      name: DEFAULT_NETWORK === 'mainnet' ? 'Bitcoin' : 'Bitcoin Testnet',
      family: 'bitcoin'
    }
  }
  const evm = findBuiltinEvmNetworkConfig(DEFAULT_NETWORK, chainId)
  return evm ? { chainId, name: evm.displayName, family: 'evm' } : null
}
