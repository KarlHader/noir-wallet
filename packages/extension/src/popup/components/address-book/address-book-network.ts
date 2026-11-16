import { findBuiltinEvmNetworkConfig } from '@/config/networks'
import { resolveEvmChainIconAlias } from '@/config/icons'
import { getBitcoinChainId, getZcashChainId, parseChainId } from '@/core/chains/registry'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import { parseZcashAddress } from '@/core/address-book/address-book'
import type { AccountNetworksCatalogView } from '@/popup/services/account-networks-client'
import type { AddressBookContact } from '@/core/address-book/address-book'
import { ALL_EVM_NETWORKS_CHAIN_ID, ALL_EVM_NETWORKS_NAME } from '@/core/address-book/address-book'

export interface AddressBookNetworkChoice {
  readonly chainId: string
  readonly name: string
  readonly family: AddressBookContact['chainFamily']
  readonly iconChain?: string
}

export const ALL_EVM_NETWORKS_CHOICE: AddressBookNetworkChoice = {
  chainId: ALL_EVM_NETWORKS_CHAIN_ID,
  name: ALL_EVM_NETWORKS_NAME,
  family: 'evm'
}

export function getAddressBookContactIconChain(contact: AddressBookContact): string {
  return contact.chainId === ALL_EVM_NETWORKS_CHAIN_ID
    ? 'evm'
    : resolveChainIconAlias(contact.chainFamily, contact.networkName, contact.chainId)
}

export function getAddressBookNetworkChoice(chainId: string): AddressBookNetworkChoice | null {
  if (chainId === ALL_EVM_NETWORKS_CHAIN_ID) return ALL_EVM_NETWORKS_CHOICE
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
  return evm ? { chainId, name: evm.displayName, family: 'evm', iconChain: evm.iconChain } : null
}

export function getAddressBookNetworkChoices(
  catalog: AccountNetworksCatalogView | null
): readonly AddressBookNetworkChoice[] {
  const choices = new Map<string, AddressBookNetworkChoice>()
  for (const account of catalog?.accounts ?? []) {
    for (const network of account.networks) {
      const choice =
        getAddressBookNetworkChoice(network.chain.id) ??
        (network.chain.family === 'evm'
          ? {
              chainId: network.chain.id,
              name: network.chain.displayName,
              family: 'evm' as const,
              iconChain: resolveEvmChainIconAlias(network.chain.id)
            }
          : null)
      if (choice) choices.set(choice.chainId, choice)
    }
  }
  if ([...choices.values()].some(choice => choice.family === 'evm')) {
    choices.set(ALL_EVM_NETWORKS_CHAIN_ID, ALL_EVM_NETWORKS_CHOICE)
  }
  return [...choices.values()]
}

export function resolveAddressBookNetwork(
  address: string,
  networks: readonly AddressBookNetworkChoice[]
): AddressBookNetworkChoice | null {
  const value = address.trim()
  for (const network of networks) {
    if (network.family === 'evm') {
      if (/^0x[0-9a-fA-F]{40}$/.test(value)) return ALL_EVM_NETWORKS_CHOICE
      continue
    }
    try {
      if (network.family === 'zcash') parseZcashAddress(value, DEFAULT_NETWORK)
      else parseSupportedBitcoinAddress(value, parseChainId(getBitcoinChainId(DEFAULT_NETWORK)).id)
      return network
    } catch {
      // An address belongs to only one supported family in the current network mode.
    }
  }
  return null
}
