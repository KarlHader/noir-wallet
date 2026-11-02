import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { UR } from '@ngraveio/bc-ur'
import {
  CryptoAccount,
  CryptoHDKey,
  CryptoKeypath,
  CryptoMultiAccounts,
  CryptoOutput,
  PathComponent,
  ScriptExpressions
} from '@keystonehq/bc-ur-registry'
import {
  KEYSTONE_ACCOUNT_UR_TYPE,
  parseBitcoinAccount,
  parseMultiAccounts
} from '../../../src/lib/keystone/account-ur.ts'

const OFFICIAL_MULTI_ACCOUNT_CBOR =
  'a5011ae9181cf30281d9012fa203582102eae4b876a8696134b868f88cc2f51f715f2dbedb7446b8e6edf3d4541c4eb67b06d90130a10188182cf51901f5f500f500f503686b657973746f6e65047828323834373563386438306636633036626166626534366137643137353066336663663235363566370565312e302e32'

function createBitcoinAccountUr() {
  const key = new CryptoHDKey({
    isMaster: false,
    key: Buffer.from('03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f', 'hex'),
    chainCode: Buffer.from(
      '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
      'hex'
    ),
    origin: new CryptoKeypath(
      [
        new PathComponent({ index: 84, hardened: true }),
        new PathComponent({ index: 0, hardened: true }),
        new PathComponent({ index: 0, hardened: true })
      ],
      Buffer.from('37b5eed4', 'hex')
    ),
    parentFingerprint: Buffer.from('0d5de1d7', 'hex')
  })
  const account = new CryptoAccount(Buffer.from('37b5eed4', 'hex'), [
    new CryptoOutput([ScriptExpressions.WITNESS_PUBLIC_KEY_HASH], key)
  ])
  return new UR(account.toCBOR(), KEYSTONE_ACCOUNT_UR_TYPE.BITCOIN_ACCOUNT)
}

test.describe('Keystone public account QR parsing', () => {
  test('parses the official crypto-multi-accounts fixture without private material', () => {
    const result = parseMultiAccounts(
      new UR(
        Buffer.from(OFFICIAL_MULTI_ACCOUNT_CBOR, 'hex'),
        KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS
      )
    )

    expect(result).toEqual({
      type: 'multi-accounts',
      masterFingerprintHex: 'e9181cf3',
      keys: [
        {
          publicKeyHex: '02eae4b876a8696134b868f88cc2f51f715f2dbedb7446b8e6edf3d4541c4eb67b',
          derivationPath: "m/44'/501'/0'/0'"
        }
      ],
      device: 'keystone',
      deviceId: '28475c8d80f6c06bafbe46a7d1750f3fcf2565f7',
      version: '1.0.2'
    })
  })

  test('parses a BIP-84 crypto-account descriptor and public origin metadata', () => {
    const result = parseBitcoinAccount(createBitcoinAccountUr())

    expect(result.masterFingerprintHex).toBe('37b5eed4')
    expect(result.descriptors).toHaveLength(1)
    expect(result.descriptors[0].scriptExpressions).toEqual(['wpkh'])
    expect(result.descriptors[0].descriptor).toContain('wpkh(')
    expect(result.descriptors[0].key).toMatchObject({
      publicKeyHex: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
      chainCodeHex: '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
      derivationPath: "m/84'/0'/0'",
      sourceFingerprintHex: '37b5eed4',
      parentFingerprintHex: '0d5de1d7'
    })
  })

  test('rejects private keys in a Multi-Coin account export', () => {
    const privateKey = new CryptoHDKey({
      isMaster: false,
      isPrivateKey: true,
      key: Buffer.alloc(32, 7),
      origin: new CryptoKeypath([
        new PathComponent({ index: 44, hardened: true }),
        new PathComponent({ index: 60, hardened: true }),
        new PathComponent({ index: 0, hardened: true })
      ])
    })
    const payload = new CryptoMultiAccounts(
      Buffer.from('01020304', 'hex'),
      [privateKey],
      'Keystone'
    )

    expect(() =>
      parseMultiAccounts(new UR(payload.toCBOR(), KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS))
    ).toThrow(/must not contain private key material/)
  })

  test('rejects duplicate keys and unsupported device labels', () => {
    const key = new CryptoHDKey({
      isMaster: false,
      key: Buffer.from('02eae4b876a8696134b868f88cc2f51f715f2dbedb7446b8e6edf3d4541c4eb67b', 'hex'),
      origin: new CryptoKeypath([
        new PathComponent({ index: 44, hardened: true }),
        new PathComponent({ index: 60, hardened: true }),
        new PathComponent({ index: 0, hardened: true })
      ])
    })
    const duplicate = new CryptoMultiAccounts(
      Buffer.from('01020304', 'hex'),
      [key, key],
      'Keystone'
    )
    const otherDevice = new CryptoMultiAccounts(
      Buffer.from('01020304', 'hex'),
      [key],
      'Other device'
    )

    expect(() =>
      parseMultiAccounts(new UR(duplicate.toCBOR(), KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS))
    ).toThrow(/duplicate public key/)
    expect(() =>
      parseMultiAccounts(new UR(otherDevice.toCBOR(), KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS))
    ).toThrow(/not exported by a supported Keystone device/)
  })

  test('rejects a QR type that does not match the selected firmware flow', () => {
    expect(() => parseMultiAccounts(createBitcoinAccountUr())).toThrow(
      /expected crypto-multi-accounts/
    )
    expect(() =>
      parseBitcoinAccount(
        new UR(
          Buffer.from(OFFICIAL_MULTI_ACCOUNT_CBOR, 'hex'),
          KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS
        )
      )
    ).toThrow(/expected crypto-account/)
  })

  test('sanitizes malformed account QR decoding failures', () => {
    expect(() =>
      parseMultiAccounts(new UR(Buffer.from([0x01]), KEYSTONE_ACCOUNT_UR_TYPE.MULTI_ACCOUNTS))
    ).toThrow('Keystone account QR could not be decoded')
    expect(() =>
      parseBitcoinAccount(new UR(Buffer.from([0x01]), KEYSTONE_ACCOUNT_UR_TYPE.BITCOIN_ACCOUNT))
    ).toThrow('Bitcoin account QR could not be decoded')
  })
})
