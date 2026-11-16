import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  BITCOIN_ADDRESS_POLICY,
  resolveBitcoinImportDiscoverySupport
} from '../../../../src/core/chains/bitcoin/index.ts'
import { RAW_BITCOIN_ADDRESS_TYPES } from '../../../../src/infrastructure/keyring/multichain/raw-wallet-engine.ts'

test.describe('Bitcoin address policy', () => {
  test('creates new Accounts with BIP-84 and never defaults to Taproot', () => {
    expect(BITCOIN_ADDRESS_POLICY).toMatchObject({
      version: 1,
      id: 'bitcoin-mainstream-v1',
      defaultCreate: {
        addressType: 'p2wpkh',
        addressScheme: 'bitcoin-p2wpkh',
        derivationScheme: 'bip84',
        purpose: 84,
        createByDefault: true,
        discoverOnImport: true
      }
    })
    expect(BITCOIN_ADDRESS_POLICY.importDiscovery.filter(target => target.createByDefault)).toEqual(
      [BITCOIN_ADDRESS_POLICY.defaultCreate]
    )
    expect(
      BITCOIN_ADDRESS_POLICY.importDiscovery.find(target => target.addressType === 'p2tr')
    ).toMatchObject({ derivationScheme: 'bip86', createByDefault: false })
  })

  test('discovers BIP-44, BIP-49, BIP-84 and BIP-86 on import', () => {
    expect(
      BITCOIN_ADDRESS_POLICY.importDiscovery.map(target => [
        target.derivationScheme,
        target.addressType
      ])
    ).toEqual([
      ['bip84', 'p2wpkh'],
      ['bip44', 'p2pkh'],
      ['bip49', 'p2sh-p2wpkh'],
      ['bip86', 'p2tr']
    ])
    expect(new Set(BITCOIN_ADDRESS_POLICY.importDiscovery.map(target => target.purpose))).toEqual(
      new Set([44, 49, 84, 86])
    )
  })

  test('exposes every discovery target implemented by the pinned WASM', () => {
    const support = resolveBitcoinImportDiscoverySupport(
      RAW_BITCOIN_ADDRESS_TYPES.map(addressType =>
        addressType === 'p2sh_p2wpkh' ? 'p2sh-p2wpkh' : addressType
      )
    )

    expect(support.available.map(target => target.derivationScheme)).toEqual([
      'bip84',
      'bip44',
      'bip49',
      'bip86'
    ])
    expect(support.waiting).toEqual([])
    expect(Object.isFrozen(support.available)).toBe(true)
    expect(Object.isFrozen(support.waiting)).toBe(true)
  })

  test('rejects duplicate or unknown engine capability declarations', () => {
    expect(() => resolveBitcoinImportDiscoverySupport(['p2wpkh', 'p2wpkh'])).toThrow(/Duplicate/)
    expect(() => resolveBitcoinImportDiscoverySupport(['legacy'])).toThrow(/Unsupported/)
  })
})
