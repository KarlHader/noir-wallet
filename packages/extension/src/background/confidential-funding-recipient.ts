import { isAddress } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { getZcashChainId } from '@/core/chains/registry'
import type { Network } from '@/types'

export function isValidExternalRecipient(
  address: string,
  destinationChainId: string,
  network: Network
): boolean {
  if (destinationChainId === getZcashChainId(network)) {
    try {
      return parseZcashAddress(address, network).address === address
    } catch {
      return false
    }
  }
  return isAddress(address) && !/^0x0{40}$/i.test(address)
}

export function externalRecipientsMatch(
  left: string,
  right: string,
  destinationChainId: string,
  network: Network
): boolean {
  return destinationChainId === getZcashChainId(network)
    ? left === right
    : left.toLowerCase() === right.toLowerCase()
}
