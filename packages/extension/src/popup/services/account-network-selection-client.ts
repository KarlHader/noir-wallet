import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '@/core/chains/registry'
import type { AccountNetworkFamily } from '@/core/wallet/account-network-selection'
import { getResponseErrorMessage } from '@/lib/errors'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

const FAMILY_ORDER: readonly AccountNetworkFamily[] = ['zcash', 'evm', 'bitcoin', 'solana', 'near']

export function availableSoftwareAccountFamilies(): readonly AccountNetworkFamily[] {
  const available = new Set(
    createBuildAddressGatedChainRegistry(createInitialProductChainRegistry(DEFAULT_NETWORK))
      .list()
      .map(chain => chain.family)
  )
  return FAMILY_ORDER.filter(family => available.has(family))
}

export async function setAccountNetworkSelection(input: {
  readonly walletId: string
  readonly accountId: string
  readonly families: readonly AccountNetworkFamily[]
  readonly chainIds: readonly string[]
  readonly birthdayHeight?: number
}): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'SET_ACCOUNT_NETWORK_SELECTION',
    walletId: input.walletId,
    accountId: input.accountId,
    families: input.families,
    chainIds: input.chainIds,
    ...(input.birthdayHeight === undefined ? {} : { birthdayHeight: input.birthdayHeight })
  })
  if (
    typeof response !== 'object' ||
    response === null ||
    !('success' in response) ||
    response.success !== true
  ) {
    throw new Error(getResponseErrorMessage(response) ?? 'Could not update account networks')
  }
}
