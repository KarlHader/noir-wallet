import { isAddress } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { parseNearAccountId } from '@/core/chains/near/identifiers'
import { getZcashChainId } from '@/core/chains/registry'
import type { Network } from '@/types'

function isCanonicalNearAccount(address: string): boolean {
  try {
    return parseNearAccountId(address) === address
  } catch {
    return false
  }
}

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
  if (destinationChainId.startsWith('near:')) return isCanonicalNearAccount(address)
  return isAddress(address) && !/^0x0{40}$/i.test(address)
}

export function externalRecipientsMatch(
  left: string,
  right: string,
  destinationChainId: string,
  network: Network
): boolean {
  return destinationChainId === getZcashChainId(network) || destinationChainId.startsWith('near:')
    ? left === right
    : left.toLowerCase() === right.toLowerCase()
}
