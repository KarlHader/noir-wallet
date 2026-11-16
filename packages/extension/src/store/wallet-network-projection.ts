import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import type { AccountData, Network, WalletItem } from '@/types'
import {
  mergeShieldedReceiveAddressHistory,
  shieldedReceiveAddress
} from '@/core/wallet/shielded-address-history'

export const EMPTY_ACCOUNT_ADDRESSES = Object.freeze({ transparent: '', shielded: '' })

export function inferLegacyAddressNetwork(account: AccountData): Network | null {
  if (
    account.addresses.transparent.startsWith('tm') ||
    account.addresses.transparent.startsWith('t2') ||
    account.addresses.shielded.startsWith('utest1') ||
    account.addresses.shielded.startsWith('ztestsapling')
  ) {
    return 'testnet'
  }
  if (
    account.addresses.transparent.startsWith('t1') ||
    account.addresses.transparent.startsWith('t3') ||
    account.addresses.shielded.startsWith('u1') ||
    account.addresses.shielded.startsWith('zs')
  ) {
    return 'mainnet'
  }
  return null
}

export function withNetworkAddresses(account: AccountData, network: Network): AccountData {
  const legacyNetwork = inferLegacyAddressNetwork(account)
  const legacyHistory = legacyNetwork
    ? mergeShieldedReceiveAddressHistory(account.shieldedAddressHistory, [
        shieldedReceiveAddress(account.addresses)
      ])
    : []
  const networkShieldedReceiveAddressHistory = {
    ...account.networkShieldedReceiveAddressHistory,
    ...(legacyNetwork && legacyHistory.length > 0
      ? {
          [legacyNetwork]: mergeShieldedReceiveAddressHistory(
            account.networkShieldedReceiveAddressHistory?.[legacyNetwork],
            legacyHistory
          )
        }
      : {})
  }
  if (account.networkAddresses) {
    return {
      ...account,
      networkAddresses: { ...account.networkAddresses },
      networkBirthdayHeights: { ...account.networkBirthdayHeights },
      networkShieldedReceiveAddressHistory,
      addresses: account.networkAddresses[network] ?? EMPTY_ACCOUNT_ADDRESSES,
      birthdayHeight: account.networkBirthdayHeights?.[network] ?? 0
    }
  }
  if (legacyNetwork === null) {
    return {
      ...account,
      networkAddresses: {},
      networkBirthdayHeights: {},
      networkShieldedReceiveAddressHistory,
      addresses: EMPTY_ACCOUNT_ADDRESSES,
      birthdayHeight: 0
    }
  }
  const networkAddresses = {
    [legacyNetwork]: account.addresses
  }
  const networkBirthdayHeights = {
    [legacyNetwork]: account.birthdayHeight
  }
  return {
    ...account,
    networkAddresses,
    networkBirthdayHeights,
    networkShieldedReceiveAddressHistory,
    addresses: networkAddresses[network] ?? EMPTY_ACCOUNT_ADDRESSES,
    birthdayHeight: networkBirthdayHeights[network] ?? 0
  }
}

export function projectWalletNetwork(wallet: WalletItem, network: Network): WalletItem {
  return {
    ...wallet,
    accounts: wallet.accounts.map(account => ({
      ...account,
      addresses: account.networkAddresses?.[network] ?? EMPTY_ACCOUNT_ADDRESSES,
      birthdayHeight: account.networkBirthdayHeights?.[network] ?? 0
    }))
  }
}

export function hasKeystoneWalletMissingNetworkProjection(
  wallets: readonly WalletItem[],
  network: Network
): boolean {
  return wallets.some(
    wallet =>
      isZcashHardwareKeySource(wallet.keySource) &&
      wallet.accounts.some(account => !account.networkAddresses?.[network])
  )
}
