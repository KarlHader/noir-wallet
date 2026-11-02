import { test } from 'node:test'
import { expect } from '@playwright/test'

import { AccountNetworksCoordinator } from '../../../src/background/account-networks.ts'
import {
  createAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '../../../src/core/chains/registry/index.ts'

const generationId = 'storage-v2:generation:account-networks'
const sourceFingerprint = 'b'.repeat(64)
const walletId = 'wallet:account-networks'
const accountId = 'account:account-networks:0'
const zcashChainId = 'bip122:05a60a92d99d85997cce3b87616c089f'
const evmChainId = 'eip155:11155111'
const bitcoinChainId = 'bip122:000000000933ea01ad0ee984209779ba'
const evmAddress = '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
const privateExecutionAddress = '0xc1d4A6EB60b9c2CFaBcDFEF60C90D04BE174E0f3'
const bitcoinAddress = 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr'
const bitcoinDerivedAddresses = {
  p2pkh: 'mfcGAzvis9JQAb6avB6WBGiGrgWzLxuGaC',
  'p2sh-p2wpkh': '2MtoVPpWDqsCuFigA4q9EbfSzJrw8ugvLfs',
  p2wpkh: bitcoinAddress,
  p2tr: 'tb1pqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq7vgt27'
}
const bitcoinSchemes = {
  p2pkh: 'bitcoin-p2pkh',
  'p2sh-p2wpkh': 'bitcoin-p2sh-p2wpkh',
  p2wpkh: 'bitcoin-p2wpkh',
  p2tr: 'bitcoin-p2tr'
}

const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.zcash',
  'chain.evm',
  'chain.bitcoin'
])

function snapshot(overrides = {}) {
  const base = {
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: walletId,
      activeAccount: { keyDomainId: walletId, accountId },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 5 },
      createdAt: 1,
      verifiedAt: 1
    },
    keyDomains: [
      {
        id: walletId,
        credentialRef: 'credential-set:account-networks',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1',
        createdAt: 1
      }
    ],
    accounts: [
      {
        id: accountId,
        keyDomainId: walletId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1
      }
    ],
    chainAccounts: [
      {
        id: 'chain-account:networks:bitcoin',
        scope: { keyDomainId: walletId, accountId, chainId: bitcoinChainId },
        derivation: { scheme: 'bip84', path: "m/84'/1'/0'/0/0" },
        identity: { kind: 'account-identifier', value: bitcoinAddress },
        createdAt: 1
      },
      {
        id: 'chain-account:networks:zcash',
        scope: { keyDomainId: walletId, accountId, chainId: zcashChainId },
        derivation: { scheme: 'zip32-unified', path: "m/32'/1'/0'" },
        identity: { kind: 'account-identifier', value: 'utest1identity' },
        createdAt: 1
      },
      {
        id: 'chain-account:networks:evm',
        scope: { keyDomainId: walletId, accountId, chainId: evmChainId },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        identity: { kind: 'account-identifier', value: evmAddress },
        createdAt: 1
      }
    ],
    addresses: [
      {
        id: 'address:networks:zcash-identity',
        chainAccountId: 'chain-account:networks:zcash',
        value: 'utest1identity',
        scheme: 'zcash-full-unified',
        purpose: 'identity',
        rotatable: false,
        preferredForReceive: false,
        privacy: 'mixed',
        walletCompatibility: 'limited'
      },
      {
        id: 'address:networks:zcash-shielded',
        chainAccountId: 'chain-account:networks:zcash',
        value: 'utest1shieldedfixture',
        scheme: 'zcash-shielded-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'shielded',
        walletCompatibility: 'limited'
      },
      {
        id: 'address:networks:zcash-transparent',
        chainAccountId: 'chain-account:networks:zcash',
        value: 'tmtransparentfixture',
        scheme: 'zcash-transparent-p2pkh',
        purpose: 'receive',
        rotatable: false,
        preferredForReceive: false,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      },
      {
        id: 'address:networks:evm',
        chainAccountId: 'chain-account:networks:evm',
        value: evmAddress,
        scheme: 'evm',
        purpose: 'identity',
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      },
      {
        id: 'address:networks:bitcoin',
        chainAccountId: 'chain-account:networks:bitcoin',
        value: bitcoinAddress,
        scheme: 'bitcoin-p2wpkh',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ]
  }
  return { ...base, ...overrides }
}

function repository(value = snapshot()) {
  return {
    async getActivePointer() {
      return { schemaVersion: 2, generationId, sourceFingerprint, committedAt: 1 }
    },
    async getSnapshot() {
      return value
    }
  }
}

test.describe('Account networks coordinator', () => {
  test('uses the selected Zcash receive address after rotation and history selection without changing identity', async () => {
    const stored = snapshot()
    const before = structuredClone(stored)
    let selected = { transparent: 'tmtransparentfixture', shielded: 'utest1rotatedfixture' }
    const scopes = []
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(stored),
      chains,
      getZcashShieldedReceiveAddress(scope) {
        scopes.push(scope)
        return selected.shielded
      }
    })
    const readZcash = async () =>
      (await coordinator.readCatalog()).accounts[0].networks.find(
        network => network.chainId === zcashChainId
      )
    expect((await readZcash()).addresses[0].value).toBe(selected.shielded)
    selected = { ...selected, shielded: 'utest1shieldedfixture' }
    expect((await readZcash()).addresses[0].value).toBe(selected.shielded)
    expect((await readZcash()).addresses[1].value).toBe(selected.transparent)
    expect(scopes).toEqual(
      Array.from({ length: 3 }, () => ({ keyDomainId: walletId, accountId, chainId: zcashChainId }))
    )
    expect(stored).toEqual(before)
  })

  test('keeps persisted Zcash addresses when no selection exists for that account and network', async () => {
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(),
      chains,
      getZcashShieldedReceiveAddress: () => null
    })
    const catalog = await coordinator.readCatalog()
    const zcash = catalog.accounts[0].networks.find(network => network.chainId === zcashChainId)
    expect(zcash.addresses.map(address => address.value)).toEqual([
      'utest1shieldedfixture',
      'tmtransparentfixture'
    ])
  })

  test('returns enabled address metadata and derives software Bitcoin and Private Execution addresses', async () => {
    const derivationRequests = []
    const peaDerivationRequests = []
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(),
      chains,
      bitcoinDerivation: {
        async deriveAddress(keyDomainId, input) {
          derivationRequests.push({ keyDomainId, input })
          return {
            address: bitcoinDerivedAddresses[input.addressType],
            addressScheme: bitcoinSchemes[input.addressType]
          }
        }
      },
      evmPeaDerivation: {
        async deriveGlobalPea(keyDomainId, addressIndex) {
          peaDerivationRequests.push({ keyDomainId, addressIndex })
          return { address: privateExecutionAddress }
        }
      }
    })

    const catalog = await coordinator.readCatalog()

    expect(catalog).toEqual({
      generationId,
      accounts: [
        {
          walletId,
          walletDisplayName: 'Wallet 1',
          walletCreatedAt: 1,
          walletSource: { kind: 'software' },
          accountId,
          accountDisplayName: 'Account 1',
          accountIndex: 0,
          active: true,
          networks: [
            {
              chainId: zcashChainId,
              accountDerivationPath: "m/32'/1'/0'",
              addresses: [
                {
                  value: 'utest1shieldedfixture',
                  scheme: 'zcash-shielded-unified',
                  privacy: 'shielded',
                  preferredForReceive: true
                },
                {
                  value: 'tmtransparentfixture',
                  scheme: 'zcash-transparent-p2pkh',
                  privacy: 'transparent',
                  preferredForReceive: false
                }
              ]
            },
            {
              chainId: evmChainId,
              addresses: [
                {
                  value: evmAddress,
                  scheme: 'evm',
                  privacy: 'transparent',
                  preferredForReceive: true
                }
              ],
              privateExecutionAddress
            },
            {
              chainId: bitcoinChainId,
              addresses: [
                {
                  value: bitcoinAddress,
                  scheme: 'bitcoin-p2wpkh',
                  privacy: 'transparent',
                  preferredForReceive: true
                },
                {
                  value: bitcoinDerivedAddresses.p2pkh,
                  scheme: 'bitcoin-p2pkh',
                  privacy: 'transparent',
                  preferredForReceive: false
                },
                {
                  value: bitcoinDerivedAddresses['p2sh-p2wpkh'],
                  scheme: 'bitcoin-p2sh-p2wpkh',
                  privacy: 'transparent',
                  preferredForReceive: false
                },
                {
                  value: bitcoinDerivedAddresses.p2tr,
                  scheme: 'bitcoin-p2tr',
                  privacy: 'transparent',
                  preferredForReceive: false
                }
              ]
            }
          ]
        }
      ]
    })
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.accounts[0].networks)).toBe(true)
    expect(derivationRequests.map(request => request.input.addressType)).toEqual([
      'p2pkh',
      'p2sh-p2wpkh',
      'p2tr'
    ])
    expect(derivationRequests.every(request => request.keyDomainId === walletId)).toBe(true)
    expect(peaDerivationRequests).toEqual([{ keyDomainId: walletId, addressIndex: 0 }])
  })

  test('keeps normal EVM addresses visible while the Private Execution credential is locked', async () => {
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(),
      chains,
      evmPeaDerivation: {
        deriveGlobalPea: async () => Promise.reject(new Error('Credential is not unlocked'))
      }
    })

    const evm = (await coordinator.readCatalog()).accounts[0].networks.find(
      network => network.chainId === evmChainId
    )
    expect(evm).toEqual({
      chainId: evmChainId,
      addresses: [
        {
          value: evmAddress,
          scheme: 'evm',
          privacy: 'transparent',
          preferredForReceive: true
        }
      ]
    })
  })

  test('does not hide an invalid Private Execution derivation response as a locked session', async () => {
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(),
      chains,
      evmPeaDerivation: {
        deriveGlobalPea: async () => Promise.reject(new Error('Invalid PEA response'))
      }
    })

    await expect(coordinator.readCatalog()).rejects.toThrow(/Invalid PEA response/)
  })

  test('keeps the persisted Native SegWit address when software derivation is unavailable', async () => {
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(),
      chains,
      bitcoinDerivation: {
        deriveAddress: async () => Promise.reject(new Error('Wallet is locked'))
      }
    })

    const bitcoin = (await coordinator.readCatalog()).accounts[0].networks.find(
      network => network.chainId === bitcoinChainId
    )
    expect(bitcoin.addresses).toEqual([
      {
        value: bitcoinAddress,
        scheme: 'bitcoin-p2wpkh',
        privacy: 'transparent',
        preferredForReceive: true
      }
    ])
  })

  test('does not hide an invalid Bitcoin derivation response as a locked session', async () => {
    const coordinator = new AccountNetworksCoordinator({
      repository: repository(),
      chains,
      bitcoinDerivation: {
        deriveAddress: async () => Promise.reject(new Error('Invalid derived Bitcoin address'))
      }
    })

    await expect(coordinator.readCatalog()).rejects.toThrow(/Invalid derived Bitcoin address/)
  })

  test('fails closed for a pointer mismatch and duplicate enabled ChainAccounts', async () => {
    const mismatched = new AccountNetworksCoordinator({
      repository: repository(
        snapshot({ manifest: { ...snapshot().manifest, sourceFingerprint: 'c'.repeat(64) } })
      ),
      chains
    })
    await expect(mismatched.readCatalog()).rejects.toThrow(/does not match its pointer/)

    const duplicatedSnapshot = snapshot()
    const duplicated = new AccountNetworksCoordinator({
      repository: repository({
        ...duplicatedSnapshot,
        chainAccounts: [
          ...duplicatedSnapshot.chainAccounts,
          { ...duplicatedSnapshot.chainAccounts[2], id: 'chain-account:networks:evm-duplicate' }
        ]
      }),
      chains
    })
    await expect(duplicated.readCatalog()).rejects.toThrow(/duplicate enabled ChainAccounts/)
  })

  test('projects only the address capabilities declared by a Keystone Wallet', async () => {
    const activeSnapshot = snapshot()
    const coordinator = new AccountNetworksCoordinator({
      repository: repository({
        ...activeSnapshot,
        keyDomains: activeSnapshot.keyDomains.map(keyDomain => ({
          ...keyDomain,
          source: {
            kind: 'hardware',
            vendor: 'keystone',
            firmwareProfile: 'cypherpunk',
            capabilities: ['zcash']
          }
        }))
      }),
      chains
    })

    const catalog = await coordinator.readCatalog()
    expect(catalog.accounts[0].walletSource).toEqual({
      kind: 'hardware',
      hardware: {
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash']
      }
    })
    expect(catalog.accounts[0].networks).toEqual([
      {
        chainId: zcashChainId,
        accountDerivationPath: "m/32'/1'/0'",
        addresses: [
          {
            value: 'utest1shieldedfixture',
            scheme: 'zcash-shielded-unified',
            privacy: 'shielded',
            preferredForReceive: true
          },
          {
            value: 'tmtransparentfixture',
            scheme: 'zcash-transparent-p2pkh',
            privacy: 'transparent',
            preferredForReceive: false
          }
        ]
      }
    ])

    const multiCoin = new AccountNetworksCoordinator({
      repository: repository({
        ...activeSnapshot,
        keyDomains: activeSnapshot.keyDomains.map(keyDomain => ({
          ...keyDomain,
          source: {
            kind: 'hardware',
            vendor: 'keystone',
            firmwareProfile: 'multi-coin',
            capabilities: ['evm', 'bitcoin']
          }
        }))
      }),
      chains
    })
    expect(
      (await multiCoin.readCatalog()).accounts[0].networks.map(network => network.chainId)
    ).toEqual([evmChainId, bitcoinChainId])
  })
})
