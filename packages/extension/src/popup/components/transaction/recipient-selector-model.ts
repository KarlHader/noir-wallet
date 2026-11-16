import type { AddressBookContact } from '@/core/address-book/address-book'
import { selectAddressBookContactsForChain } from '@/core/address-book/address-book'
import type { Network } from '@/types'
import { isGeneratedWalletTimestampName } from '@/lib/format'
import type {
  AccountNetworkAddressView,
  AccountNetworksCatalogView
} from '@/popup/services/account-networks-client'

export interface MyAccountRecipientAddress extends AccountNetworkAddressView {
  readonly executionMode?: 'main' | 'private'
}

export interface MyAccountRecipientGroup {
  readonly key: string
  readonly walletId: string
  readonly accountId: string
  readonly walletDisplayName: string
  readonly accountDisplayName: string
  readonly active: boolean
  readonly addresses: readonly MyAccountRecipientAddress[]
}

export interface MyWalletRecipientGroup {
  readonly walletId: string
  readonly walletDisplayName: string
  readonly accounts: readonly MyAccountRecipientGroup[]
}

export interface MyAccountRecipientGroupOptions {
  readonly includeUnavailableAccounts?: boolean
  readonly includeCurrentAccount?: boolean
}

export function getMyAccountRecipientUnavailableReason(
  address: Pick<MyAccountRecipientAddress, 'value' | 'executionMode'>,
  sendingAddress: string | undefined,
  disablePrivateExecutionAddresses = false
): string | null {
  if (disablePrivateExecutionAddresses && address.executionMode === 'private') {
    return 'Private execution addresses cannot be selected for Send.'
  }
  if (sendingAddress && address.value.toLowerCase() === sendingAddress.toLowerCase()) {
    return 'This is the sending address.'
  }
  return null
}

function normalizedAddress(chainId: string, address: string): string {
  return chainId.startsWith('eip155:') ? address.toLowerCase() : address
}

export function buildMyAccountRecipientGroups(
  catalog: AccountNetworksCatalogView | null,
  chainId: string,
  excludeAddresses: readonly string[] = [],
  options: MyAccountRecipientGroupOptions = {}
): readonly MyAccountRecipientGroup[] {
  if (!catalog) return Object.freeze([])

  const excluded = new Set(excludeAddresses.map(address => normalizedAddress(chainId, address)))
  const seen = new Set<string>()
  const groups: MyAccountRecipientGroup[] = []

  for (const account of catalog.accounts) {
    const network = account.networks.find(candidate => candidate.chain.id === chainId)
    if (!network && !options.includeUnavailableAccounts) continue

    const isZcash = network?.chain.family === 'zcash'
    const isEvm = network?.chain.family === 'evm'
    if (account.active && network && !isZcash && !isEvm && !options.includeCurrentAccount) {
      continue
    }

    let receiveAddresses: readonly AccountNetworkAddressView[] = []
    if (network) {
      receiveAddresses = isZcash
        ? network.addresses
        : [
            network.addresses.find(address => address.preferredForReceive) ?? network.addresses[0]
          ].filter((address): address is AccountNetworkAddressView => address !== undefined)
    }
    const candidates: readonly MyAccountRecipientAddress[] =
      isEvm && network
        ? [
            ...receiveAddresses.map(address => ({ ...address, executionMode: 'main' as const })),
            ...(network.privateExecutionAddress
              ? [
                  {
                    value: network.privateExecutionAddress,
                    scheme: 'evm',
                    privacy: 'transparent' as const,
                    preferredForReceive: false,
                    executionMode: 'private' as const
                  }
                ]
              : [])
          ]
        : receiveAddresses
    const addresses = candidates.filter(address => {
      const normalized = normalizedAddress(chainId, address.value)
      if (excluded.has(normalized) || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    if (addresses.length === 0 && network) continue

    groups.push(
      Object.freeze({
        key: `${account.walletId}:${account.accountId}`,
        walletId: account.walletId,
        accountId: account.accountId,
        walletDisplayName: isGeneratedWalletTimestampName(account.walletDisplayName)
          ? ''
          : account.walletDisplayName,
        accountDisplayName: account.accountDisplayName,
        active: account.active,
        addresses: Object.freeze(addresses)
      })
    )
  }

  const activeWalletId = groups.find(group => group.active)?.walletId
  const walletOrder = new Map<string, number>()
  groups.forEach((group, index) => {
    if (!walletOrder.has(group.walletId)) walletOrder.set(group.walletId, index)
  })
  return Object.freeze(
    groups
      .map((group, index) => ({ group, index }))
      .sort((left, right) => {
        const activeOrder =
          Number(right.group.walletId === activeWalletId) -
          Number(left.group.walletId === activeWalletId)
        if (activeOrder !== 0) return activeOrder
        if (left.group.walletId === right.group.walletId) {
          return Number(right.group.active) - Number(left.group.active) || left.index - right.index
        }
        return walletOrder.get(left.group.walletId)! - walletOrder.get(right.group.walletId)!
      })
      .map(entry => entry.group)
  )
}

export function buildMyWalletRecipientGroups(
  accounts: readonly MyAccountRecipientGroup[]
): readonly MyWalletRecipientGroup[] {
  const wallets = new Map<string, MyAccountRecipientGroup[]>()
  for (const account of accounts) {
    const existing = wallets.get(account.walletId)
    if (existing) existing.push(account)
    else wallets.set(account.walletId, [account])
  }
  return Object.freeze(
    [...wallets].map(([walletId, walletAccounts]) =>
      Object.freeze({
        walletId,
        walletDisplayName: walletAccounts[0]!.walletDisplayName,
        accounts: Object.freeze(walletAccounts)
      })
    )
  )
}

export function buildSavedRecipientList(
  contacts: readonly AddressBookContact[],
  chainId: string,
  network: Network,
  excludeAddresses: readonly string[] = []
): readonly AddressBookContact[] {
  const excluded = new Set(excludeAddresses.map(address => normalizedAddress(chainId, address)))
  return Object.freeze(
    selectAddressBookContactsForChain(contacts, chainId, network)
      .filter(contact => !excluded.has(normalizedAddress(chainId, contact.address)))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}
