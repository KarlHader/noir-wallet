import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ensureActiveSoftwarePearlNetworkAccount } from '../../../src/background/pearl-network-metadata.ts'
import { parseStorageV2Snapshot } from '../../../src/infrastructure/persistence/schema/storage-v2-validation.ts'

const pearlChainId = 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
const zcashChainId = 'bip122:05a60a92d99d85997cce3b87616c089f'
const bitcoinChainId = 'bip122:000000000933ea01ad0ee984209779ba'

function snapshotWithoutPearl() {
  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: 2,
      generationId: 'source',
      status: 'verified',
      sourceFingerprint: '1'.repeat(64),
      mainKeyDomainId: 'wallet:test',
      activeAccount: { keyDomainId: 'wallet:test', accountId: 'account:test' },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 2, addresses: 4 },
      createdAt: 1,
      verifiedAt: 1
    },
    keyDomains: [
      {
        id: 'wallet:test',
        credentialRef: 'credential:test',
        source: { kind: 'software', mnemonicWordCount: 12 },
        displayName: 'Wallet 1',
        createdAt: 1
      }
    ],
    accounts: [
      {
        id: 'account:test',
        keyDomainId: 'wallet:test',
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1
      }
    ],
    chainAccounts: [
      {
        id: 'chain-account:zcash',
        scope: {
          keyDomainId: 'wallet:test',
          accountId: 'account:test',
          chainId: zcashChainId
        },
        derivation: { scheme: 'zip32-unified', path: "m/32'/1'/0'" },
        identity: { kind: 'account-identifier', value: 'utest1NetworkFullFixture' },
        createdAt: 1
      },
      {
        id: 'chain-account:bitcoin',
        scope: {
          keyDomainId: 'wallet:test',
          accountId: 'account:test',
          chainId: bitcoinChainId
        },
        derivation: { scheme: 'bip84', path: "m/84'/1'/0'/0/0" },
        identity: {
          kind: 'account-identifier',
          value: 'tb1q5cyxnuxmeuwuvkwfem96llyxfqv3d8hl9r5rpt'
        },
        createdAt: 1
      }
    ],
    addresses: [
      {
        id: 'address:zcash-full',
        chainAccountId: 'chain-account:zcash',
        value: 'utest1NetworkFullFixture',
        scheme: 'zcash-full-unified',
        purpose: 'identity',
        rotatable: false,
        preferredForReceive: false,
        privacy: 'mixed',
        walletCompatibility: 'limited'
      },
      {
        id: 'address:zcash-shielded',
        chainAccountId: 'chain-account:zcash',
        value: 'utest1NetworkFixture',
        scheme: 'zcash-shielded-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'shielded',
        walletCompatibility: 'limited'
      },
      {
        id: 'address:zcash-transparent',
        chainAccountId: 'chain-account:zcash',
        value: 'tmNetworkFixture',
        scheme: 'zcash-transparent-p2pkh',
        purpose: 'receive',
        rotatable: false,
        preferredForReceive: false,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      },
      {
        id: 'address:bitcoin',
        chainAccountId: 'chain-account:bitcoin',
        value: 'tb1q5cyxnuxmeuwuvkwfem96llyxfqv3d8hl9r5rpt',
        scheme: 'bitcoin-p2wpkh',
        purpose: 'receive',
        derivation: { scheme: 'bip84', path: "m/84'/1'/0'/0/0" },
        rotatable: true,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ]
  })
}

test('provisions Pearl from Storage V2 Zcash addresses before shared sync', async () => {
  let active = {
    schemaVersion: 2,
    generationId: 'source',
    sourceFingerprint: '1'.repeat(64),
    committedAt: 1
  }
  const snapshots = new Map([['source', snapshotWithoutPearl()]])
  let synchronized = null

  await ensureActiveSoftwarePearlNetworkAccount({
    network: 'testnet',
    storageRepository: {
      getActivePointer: async () => active,
      getSnapshot: async generationId => snapshots.get(generationId) ?? null
    },
    hasUnlockSession: async () => true,
    synchronizeSoftwareWalletNetworkMetadata: async () => undefined,
    synchronizeNetworkAccountMetadata: async values => {
      synchronized = values
      const pearl = values[0].pearl
      const next = parseStorageV2Snapshot({
        ...snapshots.get(active.generationId),
        manifest: {
          ...snapshots.get(active.generationId).manifest,
          generationId: 'with-pearl',
          counts: {
            keyDomains: 1,
            accounts: 1,
            chainAccounts: 3,
            addresses: 5
          }
        },
        chainAccounts: [
          ...snapshots.get(active.generationId).chainAccounts,
          {
            id: 'chain-account:pearl',
            scope: {
              keyDomainId: 'wallet:test',
              accountId: 'account:test',
              chainId: pearlChainId
            },
            derivation: { scheme: pearl.derivationScheme, path: pearl.derivationPath },
            identity: { kind: 'account-identifier', value: pearl.address },
            createdAt: 1
          }
        ],
        addresses: [
          ...snapshots.get(active.generationId).addresses,
          {
            id: 'address:pearl',
            chainAccountId: 'chain-account:pearl',
            value: pearl.address,
            scheme: 'pearl_p2tr',
            purpose: 'receive',
            derivation: { scheme: pearl.derivationScheme, path: pearl.derivationPath },
            rotatable: true,
            preferredForReceive: true,
            privacy: 'transparent',
            walletCompatibility: 'broad'
          }
        ]
      })
      snapshots.set('with-pearl', next)
      active = {
        schemaVersion: 2,
        generationId: 'with-pearl',
        sourceFingerprint: next.manifest.sourceFingerprint,
        committedAt: 2
      }
      return { status: 'synchronized', addedChainAccounts: 1 }
    },
    deriveBitcoinAddress: async () => ({
      chainId: bitcoinChainId,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex: 0,
      address: 'tb1q5cyxnuxmeuwuvkwfem96llyxfqv3d8hl9r5rpt',
      addressScheme: 'bitcoin-p2wpkh',
      derivationScheme: 'bip84',
      derivationPath: "m/84'/1'/0'/0/0",
      publicKey: `0x02${'11'.repeat(32)}`,
      masterFingerprint: '0x12345678'
    }),
    derivePearlAddress: async () => ({
      chainId: pearlChainId,
      address: 'tprl1ptestfixture0001',
      accountIndex: 0,
      change: false,
      addressIndex: 0,
      derivationPath: "m/86'/1'/0'/0/0",
      publicKey: `0x02${'22'.repeat(32)}`,
      masterFingerprint: '0x12345678',
      scriptPubKey: `0x5120${'33'.repeat(32)}`,
      addressScheme: 'pearl_p2tr',
      derivationScheme: 'bip86'
    })
  })

  expect(synchronized).toHaveLength(1)
  expect(synchronized[0].pearl.address).toBe('tprl1ptestfixture0001')
})
