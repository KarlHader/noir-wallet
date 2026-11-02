import { test } from 'node:test'
import { expect } from '@playwright/test'

import { AdditionalReceiveTargetsCoordinator } from '../../../src/background/receive-targets.ts'
import {
  createAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '../../../src/core/chains/registry/index.ts'

const generationId = 'storage-v2:generation:receive-test'
const sourceFingerprint = 'a'.repeat(64)
const keyDomainId = 'wallet:receive-test'
const accountId = 'account:receive-test:0'
const zcashChainId = 'bip122:05a60a92d99d85997cce3b87616c089f'
const evmChainId = 'eip155:11155111'
const bitcoinChainId = 'bip122:000000000933ea01ad0ee984209779ba'
const bitcoinAddress = 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr'
const solanaChainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const solanaAddress = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const nearChainId = 'near:testnet'
const nearAddress = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'

const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.zcash',
  'chain.evm',
  'chain.bitcoin',
  'chain.solana',
  'chain.near'
])
const getBitcoinReceiveTarget = async () => ({
  address: bitcoinAddress,
  addressType: 'p2wpkh'
})

function snapshot(addressOverrides = {}) {
  return {
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: keyDomainId,
      activeAccount: { keyDomainId, accountId },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 5, addresses: 5 },
      createdAt: 1_700_000_000_000,
      verifiedAt: 1_700_000_000_000
    },
    keyDomains: [
      {
        id: keyDomainId,
        credentialRef: 'credential-set:receive-test',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1',
        createdAt: 1_700_000_000_000
      }
    ],
    accounts: [
      {
        id: accountId,
        keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_700_000_000_000
      }
    ],
    chainAccounts: [
      {
        id: 'chain-account:receive-test:zcash',
        scope: { keyDomainId, accountId, chainId: zcashChainId },
        derivation: { scheme: 'zip32-unified', path: "m/32'/1'/0'" },
        identity: { kind: 'account-identifier', value: 'utest1fixture' },
        createdAt: 1_700_000_000_000
      },
      {
        id: 'chain-account:receive-test:bitcoin',
        scope: { keyDomainId, accountId, chainId: bitcoinChainId },
        derivation: { scheme: 'bip84', path: "m/84'/1'/0'/0/0" },
        identity: { kind: 'account-identifier', value: bitcoinAddress },
        createdAt: 1_700_000_000_000
      },
      {
        id: 'chain-account:receive-test:evm',
        scope: { keyDomainId, accountId, chainId: evmChainId },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        identity: {
          kind: 'account-identifier',
          value: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
        },
        createdAt: 1_700_000_000_000
      },
      {
        id: 'chain-account:receive-test:solana',
        scope: { keyDomainId, accountId, chainId: solanaChainId },
        derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" },
        identity: { kind: 'account-identifier', value: solanaAddress },
        createdAt: 1_700_000_000_000
      },
      {
        id: 'chain-account:receive-test:near',
        scope: { keyDomainId, accountId, chainId: nearChainId },
        derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
        identity: { kind: 'account-identifier', value: nearAddress },
        createdAt: 1_700_000_000_000
      }
    ],
    addresses: [
      {
        id: 'address:receive-test:zcash',
        chainAccountId: 'chain-account:receive-test:zcash',
        value: 'utest1fixture',
        scheme: 'zcash-shielded-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'shielded',
        walletCompatibility: 'limited'
      },
      {
        id: 'address:receive-test:evm',
        chainAccountId: 'chain-account:receive-test:evm',
        value: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb',
        scheme: 'evm',
        purpose: 'identity',
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad',
        ...addressOverrides.evm
      },
      {
        id: 'address:receive-test:bitcoin',
        chainAccountId: 'chain-account:receive-test:bitcoin',
        value: bitcoinAddress,
        scheme: 'bitcoin-p2wpkh',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad',
        ...addressOverrides.bitcoin
      },
      {
        id: 'address:receive-test:solana',
        chainAccountId: 'chain-account:receive-test:solana',
        value: solanaAddress,
        scheme: 'solana',
        purpose: 'receive',
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad',
        ...addressOverrides.solana
      },
      {
        id: 'address:receive-test:near',
        chainAccountId: 'chain-account:receive-test:near',
        value: nearAddress,
        scheme: 'near',
        purpose: 'receive',
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad',
        ...addressOverrides.near
      }
    ]
  }
}

function repository(activeSnapshot = snapshot()) {
  return {
    async getActivePointer() {
      return {
        schemaVersion: 2,
        generationId,
        sourceFingerprint,
        committedAt: 1_700_000_000_000
      }
    },
    async getSnapshot() {
      return activeSnapshot
    }
  }
}

test.describe('Additional receive targets coordinator', () => {
  test('returns enabled non-Zcash targets in registry order and binds the active Account', async () => {
    let requestedBitcoinScope = null
    const coordinator = new AdditionalReceiveTargetsCoordinator({
      repository: repository(),
      chains,
      getBitcoinReceiveTarget: async scope => {
        requestedBitcoinScope = scope
        return getBitcoinReceiveTarget()
      }
    })

    await expect(coordinator.readActive({ keyDomainId, accountId })).resolves.toEqual({
      generationId,
      keyDomainId,
      accountId,
      targets: [
        {
          chainId: evmChainId,
          kind: 'evm',
          address: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb'
        },
        {
          chainId: bitcoinChainId,
          kind: 'bitcoin',
          addressType: 'p2wpkh',
          address: bitcoinAddress
        },
        { chainId: solanaChainId, kind: 'solana', address: solanaAddress },
        { chainId: nearChainId, kind: 'near', address: nearAddress }
      ]
    })
    expect(requestedBitcoinScope).toEqual({
      keyDomainId,
      accountId,
      chainId: bitcoinChainId,
      nativeSegwitAddress: bitcoinAddress
    })
    await expect(coordinator.readCurrentActive()).resolves.toMatchObject({
      generationId,
      keyDomainId,
      accountId
    })
  })

  test('returns null when the request races an active Account change', async () => {
    const coordinator = new AdditionalReceiveTargetsCoordinator({
      repository: repository(),
      chains,
      getBitcoinReceiveTarget
    })

    await expect(
      coordinator.readActive({ keyDomainId, accountId: 'account:receive-test:1' })
    ).resolves.toBeNull()
  })

  test('returns declared Keystone public receive targets without enabling signing', async () => {
    const activeSnapshot = snapshot()
    const coordinator = new AdditionalReceiveTargetsCoordinator({
      repository: repository({
        ...activeSnapshot,
        keyDomains: activeSnapshot.keyDomains.map(keyDomain => ({
          ...keyDomain,
          source: {
            kind: 'hardware',
            vendor: 'keystone',
            firmwareProfile: 'multi-coin',
            capabilities: ['bitcoin', 'evm']
          }
        }))
      }),
      chains,
      getBitcoinReceiveTarget
    })

    await expect(coordinator.readActive({ keyDomainId, accountId })).resolves.toMatchObject({
      targets: [{ chainId: evmChainId }, { chainId: bitcoinChainId }]
    })
  })

  test('rejects malformed EVM and a missing selected Bitcoin receive target', async () => {
    const invalidEvm = new AdditionalReceiveTargetsCoordinator({
      repository: repository(snapshot({ evm: { value: '0x1234' } })),
      chains,
      getBitcoinReceiveTarget
    })
    await expect(invalidEvm.readActive({ keyDomainId, accountId })).rejects.toThrow(
      /EVM receive Address is invalid/
    )

    const missingBitcoin = new AdditionalReceiveTargetsCoordinator({
      repository: repository(),
      chains,
      getBitcoinReceiveTarget: async () => null
    })
    await expect(missingBitcoin.readActive({ keyDomainId, accountId })).rejects.toThrow(
      /receive Address is unavailable/
    )
  })
})
