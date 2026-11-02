import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAddressBookContact,
  migrateLegacyContacts,
  parseAddressBookContact,
  readLegacyContactsStorage
} from '../../../src/core/address-book/address-book.ts'
import { getBitcoinChainId, getZcashChainId } from '../../../src/core/chains/registry/index.ts'

test.describe('Address Book V2', () => {
  test('uses the exact chain and normalized address as the stable contact identity', () => {
    const ethereum = createAddressBookContact(
      {
        chainId: 'eip155:1',
        chainFamily: 'evm',
        network: 'mainnet',
        networkName: 'Ethereum',
        address: '0x11111111111111111111111111111111111111AA',
        name: 'Alice'
      },
      100
    )
    const base = createAddressBookContact(
      {
        chainId: 'eip155:8453',
        chainFamily: 'evm',
        network: 'mainnet',
        networkName: 'Base',
        address: '0x11111111111111111111111111111111111111AA',
        name: 'Alice on Base'
      },
      100
    )

    expect(ethereum.normalizedAddress).toBe('0x11111111111111111111111111111111111111aa')
    expect(ethereum.id).not.toBe(base.id)
    expect(ethereum.addressScheme).toBe('evm')
  })

  test('rejects a Bitcoin address from a different network', () => {
    expect(() =>
      createAddressBookContact({
        chainId: getBitcoinChainId('mainnet'),
        chainFamily: 'bitcoin',
        network: 'mainnet',
        networkName: 'Bitcoin',
        address: 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr',
        name: 'Testnet recipient'
      })
    ).toThrow('Invalid Bitcoin address')
  })

  test('rejects EVM chain metadata from a different network', () => {
    expect(() =>
      createAddressBookContact({
        chainId: 'eip155:1',
        chainFamily: 'evm',
        network: 'testnet',
        networkName: 'Ethereum',
        address: '0x1111111111111111111111111111111111111111',
        name: 'Wrong network'
      })
    ).toThrow('Invalid EVM contact')
  })

  test('detects persisted contact tampering', () => {
    const contact = createAddressBookContact(
      {
        chainId: getBitcoinChainId('testnet'),
        chainFamily: 'bitcoin',
        network: 'testnet',
        networkName: 'Bitcoin Testnet',
        address: 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr',
        name: 'Faucet'
      },
      100
    )

    expect(() => parseAddressBookContact({ ...contact, normalizedAddress: 'tampered' })).toThrow(
      'integrity check failed'
    )
    expect(() => parseAddressBookContact({ ...contact, networkName: 'Bitcoin' })).toThrow(
      'network name does not match'
    )
  })

  test('migrates only legacy contacts with a provable Zcash network', () => {
    const migrated = migrateLegacyContacts([
      {
        address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F',
        name: 'Mainnet',
        addedAt: 10
      },
      {
        address: `tm${'a'.repeat(33)}`,
        name: 'Testnet',
        addedAt: 20
      },
      {
        address: '0x1111111111111111111111111111111111111111',
        name: 'Ambiguous V1 record',
        addedAt: 30
      }
    ])

    expect(migrated.contacts).toHaveLength(2)
    expect(migrated.skippedCount).toBe(1)
    expect(migrated.contacts.map(contact => contact.chainId)).toEqual([
      getZcashChainId('mainnet'),
      getZcashChainId('testnet')
    ])
  })

  test('reads the legacy Zustand envelope without changing it', () => {
    const legacy = JSON.stringify({
      state: { contacts: [{ address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F' }] },
      version: 0
    })
    expect(readLegacyContactsStorage(legacy)).toEqual([
      { address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F' }
    ])
    expect(readLegacyContactsStorage({ state: { contacts: [] } })).toEqual([])
  })
})
