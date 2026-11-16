import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  deriveKeystoneBitcoinAccountAddress,
  deriveKeystoneMultiCoinBitcoinAddress,
  projectKeystoneBitcoinAccounts,
  projectKeystoneMultiCoinAccounts
} from '../../../src/lib/keystone/public-account-projection.ts'

const SECP256K1_GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ED25519_PUBLIC_KEY = 'eae4b876a8696134b868f88cc2f51f715f2dbedb7446b8e6edf3d4541c4eb67b'

function multiAccounts(keys) {
  return {
    type: 'multi-accounts',
    masterFingerprintHex: 'e9181cf3',
    keys
  }
}

function bitcoinAccount(overrides = {}) {
  const key = {
    publicKeyHex: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
    chainCodeHex: '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
    derivationPath: "m/84'/0'/0'",
    sourceFingerprintHex: '37b5eed4',
    parentFingerprintHex: '0d5de1d7',
    ...overrides.key
  }
  return {
    type: 'bitcoin-account',
    masterFingerprintHex: '37b5eed4',
    descriptors: [
      {
        descriptor: `wpkh([37b5eed4/84'/0'/0']xpub-test/0/*)`,
        scriptExpressions: ['wpkh'],
        key,
        ...overrides.descriptor
      }
    ],
    ...overrides.payload
  }
}

function bitcoinDerivationInput(overrides = {}) {
  return {
    chainId: 'bip122:000000000019d6689c085ae165831e93',
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 7,
    ...overrides
  }
}

test.describe('Keystone public account projection', () => {
  test('projects the product EVM, Solana, TRON and NEAR derivation policies', () => {
    const result = projectKeystoneMultiCoinAccounts(
      multiAccounts([
        {
          publicKeyHex: SECP256K1_GENERATOR,
          derivationPath: "m/44'/60'/0'/0/0",
          sourceFingerprintHex: 'e9181cf3'
        },
        {
          publicKeyHex: ED25519_PUBLIC_KEY,
          derivationPath: "m/44'/501'/0'/0'",
          sourceFingerprintHex: 'e9181cf3'
        },
        {
          publicKeyHex: SECP256K1_GENERATOR,
          derivationPath: "m/44'/195'/0'/0/0",
          sourceFingerprintHex: 'e9181cf3'
        },
        {
          publicKeyHex: ED25519_PUBLIC_KEY,
          derivationPath: "m/44'/397'/0'",
          sourceFingerprintHex: 'e9181cf3'
        }
      ]),
      'mainnet'
    )

    expect(result).toEqual([
      {
        family: 'evm',
        accountIndex: 0,
        derivationPath: "m/44'/60'/0'/0/0",
        identity: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'
      },
      {
        family: 'solana',
        accountIndex: 0,
        derivationPath: "m/44'/501'/0'/0'",
        identity: 'GovgcGs4SvM7SdkDHdh5Y7WTLfYa3NBt4dhSKfgkF3R4'
      },
      {
        family: 'tron',
        accountIndex: 0,
        derivationPath: "m/44'/195'/0'/0/0",
        identity: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC'
      },
      {
        family: 'near',
        accountIndex: 0,
        derivationPath: "m/44'/397'/0'",
        identity: ED25519_PUBLIC_KEY
      }
    ])
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('rejects unsupported paths, fingerprint drift and duplicate product Accounts', () => {
    expect(() =>
      projectKeystoneMultiCoinAccounts(
        multiAccounts([{ publicKeyHex: SECP256K1_GENERATOR, derivationPath: "m/44'/60'/0'/0'" }]),
        'mainnet'
      )
    ).toThrow(/no supported product Accounts/)
    expect(() =>
      projectKeystoneMultiCoinAccounts(
        multiAccounts([
          {
            publicKeyHex: SECP256K1_GENERATOR,
            derivationPath: "m/44'/60'/0'/0/0",
            sourceFingerprintHex: '01020304'
          }
        ]),
        'mainnet'
      )
    ).toThrow(/fingerprint does not match/)
    expect(() =>
      projectKeystoneMultiCoinAccounts(
        multiAccounts([
          {
            publicKeyHex: SECP256K1_GENERATOR,
            derivationPath: "m/44'/60'/0'/0/0",
            sourceFingerprintHex: 'e9181cf3'
          },
          {
            publicKeyHex: SECP256K1_GENERATOR,
            derivationPath: "m/44'/60'/0'/0/0",
            sourceFingerprintHex: 'e9181cf3'
          }
        ]),
        'mainnet'
      )
    ).toThrow(/duplicate product Accounts/)
  })

  test('rejects invalid secp256k1 and ed25519 public keys', () => {
    expect(() =>
      projectKeystoneMultiCoinAccounts(
        multiAccounts([
          {
            publicKeyHex: `02${'00'.repeat(32)}`,
            derivationPath: "m/44'/60'/0'/0/0",
            sourceFingerprintHex: 'e9181cf3'
          }
        ]),
        'mainnet'
      )
    ).toThrow(/secp256k1 public key is invalid/)
    expect(() =>
      projectKeystoneMultiCoinAccounts(
        multiAccounts([
          {
            publicKeyHex: '00',
            derivationPath: "m/44'/501'/0'/0'",
            sourceFingerprintHex: 'e9181cf3'
          }
        ]),
        'mainnet'
      )
    ).toThrow(/Solana public key is invalid/)
  })

  test('derives the first BIP-84 receive address from a Keystone account xpub', () => {
    const result = projectKeystoneBitcoinAccounts(bitcoinAccount(), 'mainnet')

    expect(result).toEqual([
      {
        family: 'bitcoin',
        accountIndex: 0,
        derivationPath: "m/84'/0'/0'/0/0",
        identity: 'bc1qz7qjtsx3lq5hvf8xn0ac62uy4cs7j9vvtyva0c',
        publicKeyHex: '02f0e62263b1f3c571b79167cd6a9a1e092abdf166fb8da0b1449b22e18bc2ca6c',
        masterFingerprintHex: '37b5eed4',
        descriptor: `wpkh([37b5eed4/84'/0'/0']xpub-test/0/*)`
      }
    ])
  })

  test('projects a firmware-style EVM and Bitcoin xpub from one Multi-Coin QR', () => {
    const result = projectKeystoneMultiCoinAccounts(
      multiAccounts([
        {
          publicKeyHex: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
          chainCodeHex: '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
          derivationPath: "m/84'/0'/0'",
          sourceFingerprintHex: 'e9181cf3',
          parentFingerprintHex: '0d5de1d7'
        }
      ]),
      'mainnet'
    )

    expect(result).toEqual([
      {
        family: 'bitcoin',
        accountIndex: 0,
        derivationPath: "m/84'/0'/0'/0/0",
        identity: 'bc1qz7qjtsx3lq5hvf8xn0ac62uy4cs7j9vvtyva0c',
        publicKeyHex: '02f0e62263b1f3c571b79167cd6a9a1e092abdf166fb8da0b1449b22e18bc2ca6c',
        masterFingerprintHex: 'e9181cf3'
      }
    ])
  })

  test('derives exact BIP-84 receive and change addresses from authenticated public exports', () => {
    const receive = deriveKeystoneBitcoinAccountAddress(
      bitcoinAccount(),
      bitcoinDerivationInput(),
      'mainnet'
    )
    expect(receive).toEqual({
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex: 7,
      address: 'bc1q0eah0hww85fylk0sff4ehlqcsygm6hmxxrc8tf',
      addressScheme: 'bitcoin-p2wpkh',
      derivationScheme: 'bip84',
      derivationPath: "m/84'/0'/0'/0/7",
      publicKey: '0x0332e2bdf0ffcee4fc605593fdda43b3db0fab8226985a3402d6d196c2b91d591a',
      masterFingerprint: '0x37b5eed4'
    })

    const change = deriveKeystoneMultiCoinBitcoinAddress(
      multiAccounts([
        {
          publicKeyHex: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
          chainCodeHex: '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
          derivationPath: "m/84'/0'/0'",
          sourceFingerprintHex: 'e9181cf3',
          parentFingerprintHex: '0d5de1d7'
        }
      ]),
      bitcoinDerivationInput({ change: true, addressIndex: 3 }),
      'mainnet'
    )
    expect(change).toMatchObject({
      change: true,
      addressIndex: 3,
      address: 'bc1qx63prc4gz75lt9hye3yn23tms8s6edfk5pa50k',
      derivationPath: "m/84'/0'/0'/1/3",
      publicKey: '0x026f42793364c1815fc958d42d085c1ca7e889ee1761f1e8a9a64885383c56c426',
      masterFingerprint: '0xe9181cf3'
    })
  })

  test('fails closed on unsupported hardware Bitcoin derivation requests', () => {
    expect(() =>
      deriveKeystoneBitcoinAccountAddress(
        bitcoinAccount(),
        bitcoinDerivationInput({ addressType: 'p2tr' }),
        'mainnet'
      )
    ).toThrow(/request is invalid/)
    expect(() =>
      deriveKeystoneBitcoinAccountAddress(
        bitcoinAccount(),
        bitcoinDerivationInput({ accountIndex: 1 }),
        'mainnet'
      )
    ).toThrow(/missing or ambiguous/)
    expect(() =>
      deriveKeystoneBitcoinAccountAddress(bitcoinAccount(), bitcoinDerivationInput(), 'testnet')
    ).toThrow(/missing or ambiguous/)
    expect(() =>
      deriveKeystoneBitcoinAccountAddress(
        bitcoinAccount({ key: { sourceFingerprintHex: '01020304' } }),
        bitcoinDerivationInput(),
        'mainnet'
      )
    ).toThrow(/fingerprint does not match/)
  })

  test('fails closed on Bitcoin network, root and descriptor policy mismatch', () => {
    expect(() => projectKeystoneBitcoinAccounts(bitcoinAccount(), 'testnet')).toThrow(
      /derivation policy/
    )
    expect(() =>
      projectKeystoneBitcoinAccounts(
        bitcoinAccount({ key: { sourceFingerprintHex: undefined } }),
        'mainnet'
      )
    ).toThrow(/source fingerprint does not match/)
    expect(() =>
      projectKeystoneBitcoinAccounts(
        bitcoinAccount({ key: { sourceFingerprintHex: '01020304' } }),
        'mainnet'
      )
    ).toThrow(/source fingerprint does not match/)
    expect(() =>
      projectKeystoneBitcoinAccounts(
        bitcoinAccount({ descriptor: { scriptExpressions: ['wsh'] } }),
        'mainnet'
      )
    ).toThrow(/no BIP-84 descriptor/)
  })
})
