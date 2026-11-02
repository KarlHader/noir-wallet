import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { UR } from '@ngraveio/bc-ur'
import { ZcashAccounts, ZcashUnifiedFullViewingKey } from '@keystonehq/bc-ur-registry-zcash'
import {
  KEYSTONE_ACCOUNT_UR_TYPE,
  parseKeystoneConnectionAccount,
  parseZcashAccounts,
  UR_TYPE
} from '../../../src/lib/keystone/index.ts'

function zcashAccountUr({
  fingerprint = Buffer.alloc(32, 0xab),
  accounts = [new ZcashUnifiedFullViewingKey('uview1testaccount', 0, 'Account 1')]
} = {}) {
  const payload = new ZcashAccounts(fingerprint, accounts)
  return new UR(payload.toCBOR(), UR_TYPE.ZCASH_ACCOUNTS)
}

test.describe('Keystone Zcash account QR parsing', () => {
  test('returns an immutable exact public account export', () => {
    expect(parseZcashAccounts(zcashAccountUr())).toEqual({
      seedFingerprintHex: 'ab'.repeat(32),
      accounts: [{ ufvk: 'uview1testaccount', index: 0, name: 'Account 1' }]
    })
  })

  test('rejects malformed fingerprints, duplicate Accounts, and oversized payloads', () => {
    expect(() =>
      parseZcashAccounts(zcashAccountUr({ fingerprint: Buffer.alloc(4, 0xab) }))
    ).toThrow(/fingerprint has an invalid length/)
    expect(() =>
      parseZcashAccounts(
        zcashAccountUr({
          accounts: [
            new ZcashUnifiedFullViewingKey('uview1testaccount', 0),
            new ZcashUnifiedFullViewingKey('uview1testaccount', 1)
          ]
        })
      )
    ).toThrow(/duplicate Accounts/)
    expect(() =>
      parseZcashAccounts(new UR(Buffer.alloc(256 * 1024 + 1), UR_TYPE.ZCASH_ACCOUNTS))
    ).toThrow(/invalid size/)
  })

  test('sanitizes malformed CBOR errors', () => {
    expect(() => parseZcashAccounts(new UR(Buffer.from([0x01]), UR_TYPE.ZCASH_ACCOUNTS))).toThrow(
      'Keystone Zcash account QR could not be decoded'
    )
  })

  test('routes only the account QR accepted by the selected firmware profile', () => {
    expect(parseKeystoneConnectionAccount('cypherpunk', zcashAccountUr())).toMatchObject({
      firmwareProfile: 'cypherpunk'
    })
    expect(() => parseKeystoneConnectionAccount('multi-coin', zcashAccountUr())).toThrow(
      /expected crypto-multi-accounts/
    )
    expect(() => parseKeystoneConnectionAccount('bitcoin-only', zcashAccountUr())).toThrow(
      /expected crypto-account/
    )
    expect(() =>
      parseKeystoneConnectionAccount(
        'cypherpunk',
        new UR(Buffer.from([0x01]), KEYSTONE_ACCOUNT_UR_TYPE.BITCOIN_ACCOUNT)
      )
    ).toThrow(/expected zcash-accounts/)
  })
})
