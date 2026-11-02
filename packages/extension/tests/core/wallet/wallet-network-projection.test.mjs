import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  EMPTY_ACCOUNT_ADDRESSES,
  hasKeystoneWalletMissingNetworkProjection,
  inferLegacyAddressNetwork,
  projectWalletNetwork,
  withNetworkAddresses
} from '../../../src/store/wallet-network-projection.ts'
import {
  mergeShieldedReceiveAddressHistory,
  shieldedReceiveAddress
} from '../../../src/core/wallet/shielded-address-history.ts'

function account(addresses, birthdayHeight = 2_000_000) {
  return {
    id: 'account-0',
    name: 'Account 1',
    derivationIndex: 0,
    addresses,
    birthdayHeight,
    isPinned: false,
    isHidden: false
  }
}

test.describe('Wallet network projection', () => {
  test('migrates legacy addresses only into the network proven by their prefixes', () => {
    const mainnet = account({ transparent: 't1-main', shielded: 'u1-main' })
    const testnet = account({ transparent: 'tm-test', shielded: 'utest1-test' })
    expect(inferLegacyAddressNetwork(mainnet)).toBe('mainnet')
    expect(inferLegacyAddressNetwork(testnet)).toBe('testnet')

    const projected = withNetworkAddresses(mainnet, 'testnet')
    expect(projected.addresses).toEqual(EMPTY_ACCOUNT_ADDRESSES)
    expect(projected.birthdayHeight).toBe(0)
    expect(projected.networkAddresses).toEqual({ mainnet: mainnet.addresses })
    expect(projected.networkBirthdayHeights).toEqual({ mainnet: 2_000_000 })
  })

  test('does not guess a network for empty or unrecognized legacy metadata', () => {
    const legacy = account({ transparent: '', shielded: 'not-a-zcash-address' })
    expect(inferLegacyAddressNetwork(legacy)).toBeNull()
    expect(withNetworkAddresses(legacy, 'mainnet')).toMatchObject({
      addresses: EMPTY_ACCOUNT_ADDRESSES,
      birthdayHeight: 0,
      networkAddresses: {},
      networkBirthdayHeights: {}
    })
  })

  test('projects both stored networks without replacing their public metadata', () => {
    const mainnet = { transparent: 't1-main', shielded: 'u1-main' }
    const testnet = { transparent: 'tm-test', shielded: 'utest1-test' }
    const source = {
      ...account(mainnet),
      networkAddresses: { mainnet, testnet },
      networkBirthdayHeights: { mainnet: 2_000_000, testnet: 3_000_000 }
    }
    const wallet = { id: 'wallet-0', name: 'Wallet 1', keySource: 'software', accounts: [source] }
    const projected = projectWalletNetwork(wallet, 'testnet')
    expect(projected.accounts[0]).toMatchObject({
      addresses: testnet,
      birthdayHeight: 3_000_000,
      networkAddresses: { mainnet, testnet }
    })
  })

  test('preserves V1 rotated shielded addresses in their proven network only', () => {
    const legacy = {
      ...account({ transparent: 't1-main', shielded: 'u1-current', fullUnified: 'u1-full' }),
      shieldedAddressHistory: [
        { shielded: 'u1-old', fullUnified: 'u1-old-full' },
        { shielded: 'u1-current', fullUnified: 'u1-full' }
      ]
    }
    const projected = withNetworkAddresses(legacy, 'testnet')
    expect(projected.networkShieldedReceiveAddressHistory).toEqual({
      mainnet: legacy.shieldedAddressHistory
    })
    expect(projected.networkShieldedReceiveAddressHistory.testnet).toBeUndefined()
    expect(withNetworkAddresses(projected, 'mainnet').networkShieldedReceiveAddressHistory).toEqual(
      projected.networkShieldedReceiveAddressHistory
    )
  })

  test('appends a rotated address once while retaining its full unified form', () => {
    const previous = { transparent: 't1-main', shielded: 'u1-previous', fullUnified: 'u1-full' }
    const current = { transparent: 't1-main', shielded: 'u1-current', fullUnified: 'u1-next' }
    expect(
      mergeShieldedReceiveAddressHistory(
        [shieldedReceiveAddress(previous)],
        [shieldedReceiveAddress(previous), shieldedReceiveAddress(current)]
      )
    ).toEqual([
      { shielded: 'u1-previous', fullUnified: 'u1-full' },
      { shielded: 'u1-current', fullUnified: 'u1-next' }
    ])
  })

  test('blocks a Keystone network switch until every Account has target metadata', () => {
    const mainnet = { transparent: 't1-main', shielded: 'u1-main' }
    const testnet = { transparent: 'tm-test', shielded: 'utest1-test' }
    const software = {
      id: 'wallet-software',
      name: 'Software',
      keySource: 'software',
      accounts: [account(mainnet)]
    }
    const keystone = {
      id: 'wallet-keystone',
      name: 'Keystone',
      keySource: 'keystone',
      accounts: [{ ...account(mainnet), networkAddresses: { mainnet } }]
    }

    expect(hasKeystoneWalletMissingNetworkProjection([software, keystone], 'testnet')).toBe(true)
    keystone.accounts[0].networkAddresses.testnet = testnet
    expect(hasKeystoneWalletMissingNetworkProjection([software, keystone], 'testnet')).toBe(false)
  })
})
