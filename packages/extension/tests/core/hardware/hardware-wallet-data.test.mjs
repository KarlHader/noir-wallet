import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
  createBitcoinHardwareCredential,
  createMultiAccountsHardwareCredential,
  createZcashHardwareCredential,
  createLedgerHardwareCredential,
  legacyZcashHardwareWalletData,
  parseHardwareWalletData,
  parseKeystoneHardwareCredential,
  parseStoredKeystoneHardwareCredential,
  parseStoredHardwareCredential
} from '../../../src/core/wallet/hardware-wallet-data.ts'
import { SecureStorage } from '../../../src/core/wallet/secure-storage.ts'

const validPayload = Object.freeze({
  ufvk: 'uview1testfixture',
  seedFingerprintHex: 'AB'.repeat(32),
  accountHdIndex: 0
})

test.describe('Ledger Zcash hardware credentials', () => {
  const legacy = Object.freeze({
    ufvk: 'uview1ledgerfixture',
    accountHdIndex: 4,
    deviceModel: 'nanoX',
    deviceName: 'Ledger Nano X',
    ledgerTransport: 'usb',
    ledgerSigningTransport: 'bluetooth'
  })

  test('reads the frozen V1 Ledger envelope shape and preserves vendor identity', () => {
    const credential = parseStoredHardwareCredential(legacy)
    expect(credential).toMatchObject({
      vendor: 'ledger',
      firmwareProfile: 'zcash',
      capabilities: ['zcash'],
      ledgerSigningTransport: 'bluetooth',
      accountExport: {
        ufvk: legacy.ufvk,
        accountHdIndex: 4,
        seedFingerprintHex: '0'.repeat(64)
      }
    })
    expect(legacyZcashHardwareWalletData(credential)).toMatchObject({
      ufvk: legacy.ufvk,
      accountHdIndex: 4
    })
    expect(parseStoredHardwareCredential(createLedgerHardwareCredential(legacy))).toEqual(
      credential
    )
  })

  test('rejects a forged Ledger fingerprint or capability escalation', () => {
    expect(() =>
      parseStoredHardwareCredential({ ...legacy, seedFingerprintHex: 'a1'.repeat(32) })
    ).toThrow('Invalid legacy Ledger credential')
    expect(() =>
      parseStoredHardwareCredential({ ...legacy, ledgerSigningTransport: 'wireless' })
    ).toThrow('Invalid legacy Ledger credential')
    expect(() =>
      parseStoredHardwareCredential({
        ...createLedgerHardwareCredential(legacy),
        capabilities: ['zcash', 'evm']
      })
    ).toThrow('Invalid Ledger hardware credential')
  })
})

test.describe('legacy Keystone hardware credential payload', () => {
  test('accepts the retained V1 shape and normalizes its fingerprint', () => {
    expect(parseHardwareWalletData(validPayload)).toEqual({
      ...validPayload,
      seedFingerprintHex: 'ab'.repeat(32)
    })
  })

  test('rejects missing, extra and malformed fields', () => {
    expect(() => parseHardwareWalletData({ ...validPayload, extra: true })).toThrow(
      'Invalid Keystone Zcash credential payload'
    )
    expect(() =>
      parseHardwareWalletData({ ...validPayload, seedFingerprintHex: 'ab'.repeat(31) })
    ).toThrow('Invalid Keystone Zcash credential payload')
    expect(() => parseHardwareWalletData({ ...validPayload, accountHdIndex: -1 })).toThrow(
      'Invalid Keystone Zcash credential payload'
    )
  })

  test('rejects unbounded or whitespace-mutated viewing keys', () => {
    expect(() => parseHardwareWalletData({ ...validPayload, ufvk: ' uview1testfixture' })).toThrow(
      'Invalid Keystone Zcash credential payload'
    )
    expect(() => parseHardwareWalletData({ ...validPayload, ufvk: 'u'.repeat(4097) })).toThrow(
      'Invalid Keystone Zcash credential payload'
    )
  })

  test('upgrades the retained V1 payload to a versioned Cypherpunk credential', () => {
    const credential = parseStoredKeystoneHardwareCredential(validPayload)

    expect(credential).toEqual({
      schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
      vendor: 'keystone',
      firmwareProfile: 'cypherpunk',
      capabilities: ['zcash'],
      accountExport: {
        protocol: 'zcash-accounts-v1',
        ufvk: validPayload.ufvk,
        seedFingerprintHex: 'ab'.repeat(32),
        accountHdIndex: 0
      }
    })
    expect(legacyZcashHardwareWalletData(credential)).toEqual({
      ufvk: validPayload.ufvk,
      seedFingerprintHex: 'ab'.repeat(32),
      accountHdIndex: 0
    })
    expect(
      parseStoredKeystoneHardwareCredential(createZcashHardwareCredential(validPayload))
    ).toEqual(credential)
  })

  test('rejects attempts to bind a Zcash export to another firmware or capability', () => {
    const credential = createZcashHardwareCredential(validPayload)

    expect(() =>
      parseKeystoneHardwareCredential({ ...credential, firmwareProfile: 'multi-coin' })
    ).toThrow('Invalid Keystone Zcash firmware capability binding')
    expect(() =>
      parseKeystoneHardwareCredential({ ...credential, capabilities: ['zcash', 'bitcoin'] })
    ).toThrow('Invalid Keystone Zcash firmware capability binding')
  })
})

const multiAccountsPayload = Object.freeze({
  type: 'multi-accounts',
  masterFingerprintHex: 'A1B2C3D4',
  keys: Object.freeze([
    Object.freeze({
      publicKeyHex: `02${'11'.repeat(32)}`,
      chainCodeHex: '22'.repeat(32),
      derivationPath: "m/44'/60'/0'/0/0"
    }),
    Object.freeze({
      publicKeyHex: `03${'33'.repeat(32)}`,
      derivationPath: "m/44'/501'/0'/0'"
    }),
    Object.freeze({
      publicKeyHex: `02${'44'.repeat(32)}`,
      chainCodeHex: '55'.repeat(32),
      derivationPath: "m/84'/0'/0'"
    })
  ]),
  device: 'Keystone 3 Pro',
  deviceId: 'device-fixture',
  version: '2.0.0'
})

const bitcoinPayload = Object.freeze({
  type: 'bitcoin-account',
  masterFingerprintHex: 'A1B2C3D4',
  descriptors: Object.freeze([
    Object.freeze({
      descriptor: `wpkh([a1b2c3d4/84'/0'/0']xpub-fixture/0/*)`,
      scriptExpressions: Object.freeze(['wpkh']),
      key: Object.freeze({
        publicKeyHex: `02${'44'.repeat(32)}`,
        chainCodeHex: '55'.repeat(32),
        derivationPath: "m/84'/0'/0'",
        sourceFingerprintHex: 'a1b2c3d4'
      })
    })
  ])
})

test.describe('versioned Keystone hardware credential payload', () => {
  test('derives Multi-Coin capabilities from exact supported BIP-44 paths', () => {
    const credential = createMultiAccountsHardwareCredential(multiAccountsPayload)

    expect(credential).toMatchObject({
      schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
      vendor: 'keystone',
      firmwareProfile: 'multi-coin',
      capabilities: ['bitcoin', 'evm', 'solana'],
      accountExport: {
        protocol: 'crypto-multi-accounts-v1',
        masterFingerprintHex: 'a1b2c3d4'
      }
    })
    expect(legacyZcashHardwareWalletData(credential)).toBeNull()
  })

  test('rejects caller-supplied Multi-Coin capabilities and unknown public-key paths', () => {
    const credential = createMultiAccountsHardwareCredential(multiAccountsPayload)

    expect(() =>
      parseKeystoneHardwareCredential({ ...credential, capabilities: ['bitcoin', 'evm', 'tron'] })
    ).toThrow('Invalid Keystone Multi-Coin capability binding')
    expect(() =>
      createMultiAccountsHardwareCredential({
        ...multiAccountsPayload,
        keys: [{ ...multiAccountsPayload.keys[0], derivationPath: "m/44'/999'/0'/0/0" }]
      })
    ).toThrow('contains no supported product keys')
  })

  test('retains official extra-chain keys without escalating NoirWallet capabilities', () => {
    const credential = createMultiAccountsHardwareCredential({
      ...multiAccountsPayload,
      keys: [
        ...multiAccountsPayload.keys,
        {
          publicKeyHex: `02${'66'.repeat(32)}`,
          chainCodeHex: '77'.repeat(32),
          derivationPath: "m/44'/3'/0'"
        }
      ]
    })

    expect(credential.capabilities).toEqual(['bitcoin', 'evm', 'solana'])
    expect(credential.accountExport.keys).toHaveLength(4)
  })

  test('binds a Bitcoin descriptor export to the selected firmware profile', () => {
    for (const profile of ['multi-coin', 'cypherpunk', 'bitcoin-only']) {
      const credential = createBitcoinHardwareCredential(bitcoinPayload, profile)
      expect(credential).toMatchObject({
        firmwareProfile: profile,
        capabilities: ['bitcoin'],
        accountExport: {
          protocol: 'crypto-account-v1',
          masterFingerprintHex: 'a1b2c3d4'
        }
      })
    }
  })

  test('rejects malformed Bitcoin descriptors and capability escalation', () => {
    const credential = createBitcoinHardwareCredential(bitcoinPayload, 'bitcoin-only')

    expect(() =>
      parseKeystoneHardwareCredential({ ...credential, capabilities: ['bitcoin', 'evm'] })
    ).toThrow('Invalid Keystone Bitcoin capability binding')
    expect(() =>
      createBitcoinHardwareCredential(
        {
          ...bitcoinPayload,
          descriptors: [
            {
              ...bitcoinPayload.descriptors[0],
              key: { ...bitcoinPayload.descriptors[0].key, chainCodeHex: undefined }
            }
          ]
        },
        'bitcoin-only'
      )
    ).toThrow('Invalid Keystone Bitcoin descriptor chain code')
  })

  test('uses exact schemas for hardware credential records', () => {
    const credential = createMultiAccountsHardwareCredential(multiAccountsPayload)

    expect(() => parseKeystoneHardwareCredential({ ...credential, extra: true })).toThrow(
      'Invalid Keystone hardware credential'
    )
    expect(() =>
      parseKeystoneHardwareCredential({
        ...credential,
        accountExport: { ...credential.accountExport, secret: 'not-allowed' }
      })
    ).toThrow('Invalid Keystone Multi-Coin account export')
  })
})

test.describe('Keystone encrypted local storage compatibility', () => {
  test('reads retained V1 data and writes schema V2 without exposing it to the legacy API', async () => {
    const persisted = {}
    const previousChrome = globalThis.chrome
    globalThis.chrome = {
      storage: {
        local: {
          async get(key) {
            if (key === null) return { ...persisted }
            const keys = Array.isArray(key) ? key : [key]
            return Object.fromEntries(
              keys.filter(item => item in persisted).map(item => [item, persisted[item]])
            )
          },
          async set(values) {
            Object.assign(persisted, values)
          },
          async remove(key) {
            delete persisted[key]
          }
        }
      }
    }

    try {
      persisted['hw_legacy'] = await SecureStorage.encrypt(JSON.stringify(validPayload), 'password')
      await expect(SecureStorage.loadHardwareWalletData('legacy', 'password')).resolves.toEqual({
        ufvk: validPayload.ufvk,
        seedFingerprintHex: 'ab'.repeat(32),
        accountHdIndex: 0
      })

      await SecureStorage.saveHardwareWalletData('new', validPayload, 'password')
      const plaintext = JSON.parse(await SecureStorage.decrypt(persisted['hw_new'], 'password'))
      expect(plaintext).toMatchObject({
        schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash'],
        accountExport: { protocol: 'zcash-accounts-v1' }
      })
      await expect(
        SecureStorage.loadHardwareWalletData('new', 'wrong-password')
      ).resolves.toBeNull()

      await SecureStorage.saveKeystoneHardwareCredential(
        'bitcoin',
        createBitcoinHardwareCredential(bitcoinPayload, 'bitcoin-only'),
        'password'
      )
      await expect(
        SecureStorage.loadKeystoneHardwareCredential('bitcoin', 'password')
      ).resolves.toMatchObject({ firmwareProfile: 'bitcoin-only', capabilities: ['bitcoin'] })
      await expect(SecureStorage.loadHardwareWalletData('bitcoin', 'password')).resolves.toBeNull()
    } finally {
      globalThis.chrome = previousChrome
    }
  })
})
