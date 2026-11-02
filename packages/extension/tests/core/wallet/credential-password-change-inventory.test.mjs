import { test } from 'node:test'
import { expect } from '@playwright/test'
import { assertPasswordChangeCredentialInventorySupported } from '../../../src/infrastructure/keyring/migration/credential-password-change-support.ts'

function discovery(keySource) {
  return {
    status: 'ready',
    wallets: keySource ? [{ id: 'wallet:1', keySource }] : []
  }
}

function snapshot(source) {
  return {
    keyDomains: source ? [{ id: 'wallet:1', source }] : []
  }
}

test.describe('password-change credential inventory gate', () => {
  test('allows a software-only retained V1 and Storage V2 inventory', () => {
    expect(() =>
      assertPasswordChangeCredentialInventorySupported(
        discovery('software'),
        snapshot({ kind: 'software' })
      )
    ).not.toThrow()
  })

  test('allows a matching Keystone retained V1 and Storage V2 inventory', () => {
    expect(() =>
      assertPasswordChangeCredentialInventorySupported(
        discovery('keystone'),
        snapshot({
          kind: 'hardware',
          vendor: 'keystone',
          firmwareProfile: 'cypherpunk',
          capabilities: ['zcash']
        })
      )
    ).not.toThrow()
  })

  test('allows only an explicitly V2-native Keystone Wallet to omit retained V1', () => {
    expect(() =>
      assertPasswordChangeCredentialInventorySupported(
        { status: 'empty', wallets: [] },
        {
          keyDomains: [
            {
              id: 'wallet:keystone-v2:fixture',
              source: {
                kind: 'hardware',
                vendor: 'keystone',
                firmwareProfile: 'multi-coin',
                capabilities: ['bitcoin', 'evm']
              }
            }
          ]
        }
      )
    ).not.toThrow()

    expect(() =>
      assertPasswordChangeCredentialInventorySupported(
        { status: 'empty', wallets: [] },
        snapshot({
          kind: 'hardware',
          vendor: 'keystone',
          firmwareProfile: 'cypherpunk',
          capabilities: ['zcash']
        })
      )
    ).toThrow(/inventories differ/)
  })

  test('rejects source-kind mismatches before any password-change write', () => {
    expect(() =>
      assertPasswordChangeCredentialInventorySupported(
        discovery('software'),
        snapshot({
          kind: 'hardware',
          vendor: 'keystone',
          firmwareProfile: 'cypherpunk',
          capabilities: ['zcash']
        })
      )
    ).toThrow(/inventories differ/)
  })

  test('rejects duplicate retained V1 Wallet identifiers', () => {
    expect(() =>
      assertPasswordChangeCredentialInventorySupported(
        {
          status: 'ready',
          wallets: [
            { id: 'wallet:1', keySource: 'software' },
            { id: 'wallet:1', keySource: 'software' }
          ]
        },
        snapshot({ kind: 'software' })
      )
    ).toThrow(/inventories differ/)
  })
})
