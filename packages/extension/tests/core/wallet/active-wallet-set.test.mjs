import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  listKeySourceAllowedAccountScopes,
  loadActiveReceiveWalletSet,
  loadActiveWalletSet
} from '../../../src/core/accounts/application/index.ts'
import {
  createAddressGatedChainRegistry,
  createChainRegistry,
  createFeatureGatedChainRegistry
} from '../../../src/core/chains/registry/index.ts'

const createdAt = 1_700_000_000_000
const generationId = 'storage-v2:generation:active'
const sourceFingerprint = 'storage-v2:fingerprint:active'

const completeCapabilities = ({ addressScheme, derivationScheme }) => ({
  address: {
    status: 'available',
    addressSchemes: [addressScheme],
    derivationSchemes: [derivationScheme],
    supportsRotation: false,
    supportsChange: false
  },
  signing: {
    status: 'available',
    transactionFormats: ['transaction-v1'],
    messageFormats: []
  },
  transaction: {
    status: 'available',
    model: 'account',
    actions: ['native-transfer']
  }
})

const registry = createChainRegistry([
  {
    id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
    family: 'zcash',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Zcash',
    featureFlag: 'chain.zcash',
    capabilities: completeCapabilities({
      addressScheme: 'zcash-shielded-unified',
      derivationScheme: 'zip32-unified'
    })
  },
  {
    id: 'eip155:1',
    family: 'evm',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Ethereum',
    featureFlag: 'chain.evm',
    capabilities: completeCapabilities({ addressScheme: 'evm', derivationScheme: 'bip44' })
  },
  {
    id: 'bip122:000000000019d6689c085ae165831e93',
    family: 'bitcoin',
    network: { kind: 'mainnet', name: 'mainnet' },
    displayName: 'Bitcoin',
    featureFlag: 'chain.bitcoin',
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['bitcoin-p2wpkh', 'bitcoin-p2tr'],
        derivationSchemes: ['bip84', 'bip86'],
        supportsRotation: true,
        supportsChange: true
      },
      signing: {
        status: 'available',
        transactionFormats: ['psbt-v0'],
        messageFormats: ['bip322']
      },
      transaction: { status: 'waiting', model: 'utxo', actions: [] }
    }
  }
])

function activeRegistry(enabledFlags = ['chain.zcash']) {
  return createFeatureGatedChainRegistry(registry, enabledFlags)
}

function activeAddressRegistry(enabledFlags = ['chain.zcash']) {
  return createAddressGatedChainRegistry(registry, enabledFlags)
}

function snapshot(overrides = {}) {
  const { manifest: manifestOverrides = {}, ...snapshotOverrides } = overrides
  const keyDomainId = 'wallet:1'
  const accountId = 'account:1:0'
  const zcashChainAccountId = 'chain-account:1:0:zcash'
  const evmChainAccountId = 'chain-account:1:0:evm'
  const bitcoinChainAccountId = 'chain-account:1:0:bitcoin'
  return {
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId: keyDomainId,
      activeAccount: { keyDomainId, accountId },
      counts: { keyDomains: 1, accounts: 1, chainAccounts: 3, addresses: 3 },
      createdAt,
      verifiedAt: createdAt,
      ...manifestOverrides
    },
    keyDomains: [
      {
        id: keyDomainId,
        credentialRef: 'credential-set:1',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1',
        createdAt
      }
    ],
    accounts: [
      {
        id: accountId,
        keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt
      }
    ],
    chainAccounts: [
      {
        id: zcashChainAccountId,
        scope: {
          keyDomainId,
          accountId,
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d'
        },
        derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
        identity: { kind: 'account-identifier', value: 'u1test' },
        createdAt
      },
      {
        id: evmChainAccountId,
        scope: { keyDomainId, accountId, chainId: 'eip155:1' },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        identity: {
          kind: 'account-identifier',
          value: '0x0000000000000000000000000000000000000001'
        },
        createdAt
      },
      {
        id: bitcoinChainAccountId,
        scope: {
          keyDomainId,
          accountId,
          chainId: 'bip122:000000000019d6689c085ae165831e93'
        },
        derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
        identity: {
          kind: 'account-identifier',
          value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
        },
        createdAt
      }
    ],
    addresses: [
      {
        id: 'address:1:0:zcash',
        chainAccountId: zcashChainAccountId,
        value: 'u1test',
        scheme: 'zcash-shielded-unified',
        purpose: 'receive',
        rotatable: true,
        preferredForReceive: true,
        privacy: 'shielded',
        walletCompatibility: 'limited'
      },
      {
        id: 'address:1:0:evm',
        chainAccountId: evmChainAccountId,
        value: '0x0000000000000000000000000000000000000001',
        scheme: 'evm',
        purpose: 'identity',
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      },
      {
        id: 'address:1:0:bitcoin',
        chainAccountId: bitcoinChainAccountId,
        value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
        scheme: 'bitcoin-p2wpkh',
        purpose: 'receive',
        derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
        rotatable: true,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ],
    ...snapshotOverrides
  }
}

function repository(activeSnapshot = snapshot(), pointerOverrides = {}) {
  return {
    async getActivePointer() {
      return {
        schemaVersion: 2,
        generationId,
        sourceFingerprint,
        committedAt: createdAt,
        ...pointerOverrides
      }
    },
    async getSnapshot(requestedGenerationId) {
      expect(requestedGenerationId).toBe(generationId)
      return activeSnapshot
    }
  }
}

test.describe('Active Wallet Set reader', () => {
  test('loads the generation-bound active Account and only released ChainAccounts', async () => {
    const result = await loadActiveWalletSet({
      repository: repository(),
      chainRegistry: activeRegistry()
    })

    expect(result.generationId).toBe(generationId)
    expect(result.catalog.mainKeyDomainId).toBe('wallet:1')
    expect(result.activeAccount).toMatchObject({ id: 'account:1:0', accountIndex: 0 })
    expect(result.availableChainAccounts).toHaveLength(1)
    expect(result.availableChainAccounts[0]).toMatchObject({
      chain: { id: 'bip122:00040fe8ec8471911baa1db1266ea15d' },
      chainAccount: { id: 'chain-account:1:0:zcash' },
      addresses: [{ id: 'address:1:0:zcash', preferredForReceive: true }]
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.availableChainAccounts)).toBe(true)
  })

  test('exposes another persisted ChainAccount only after its complete release gate is enabled', async () => {
    const result = await loadActiveWalletSet({
      repository: repository(),
      chainRegistry: activeRegistry(['chain.zcash', 'chain.evm'])
    })

    expect(result.availableChainAccounts.map(item => item.chain.id)).toEqual([
      'bip122:00040fe8ec8471911baa1db1266ea15d',
      'eip155:1'
    ])
  })

  test('exposes Bitcoin to address-only readers without treating transactions as released', async () => {
    const result = await loadActiveReceiveWalletSet({
      repository: repository(),
      chainRegistry: activeAddressRegistry(['chain.zcash', 'chain.bitcoin'])
    })

    expect(result.availableChainAccounts.map(item => item.chain.family)).toEqual([
      'zcash',
      'bitcoin'
    ])
    expect(result.availableChainAccounts[1]).toMatchObject({
      chain: { capabilities: { transaction: { status: 'waiting' } } },
      addresses: [
        {
          scheme: 'bitcoin-p2wpkh',
          preferredForReceive: true,
          value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
        }
      ]
    })
  })

  test('keeps Keystone Zcash-only even when non-Zcash ChainAccounts are persisted and enabled', async () => {
    const activeSnapshot = snapshot()
    const hardwareSnapshot = {
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
    }
    const complete = await loadActiveWalletSet({
      repository: repository(hardwareSnapshot),
      chainRegistry: activeRegistry(['chain.zcash', 'chain.evm'])
    })
    const receive = await loadActiveReceiveWalletSet({
      repository: repository(hardwareSnapshot),
      chainRegistry: activeAddressRegistry(['chain.zcash', 'chain.evm', 'chain.bitcoin'])
    })

    expect(complete.availableChainAccounts.map(item => item.chain.family)).toEqual(['zcash'])
    expect(receive.availableChainAccounts.map(item => item.chain.family)).toEqual(['zcash'])
  })

  test('releases Keystone EVM signing and keeps Bitcoin available through address projection', async () => {
    const activeSnapshot = snapshot()
    const hardwareSnapshot = {
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
    }
    const complete = await loadActiveWalletSet({
      repository: repository(hardwareSnapshot),
      chainRegistry: activeRegistry(['chain.evm'])
    })
    const receive = await loadActiveReceiveWalletSet({
      repository: repository(hardwareSnapshot),
      chainRegistry: activeAddressRegistry(['chain.evm', 'chain.bitcoin'])
    })

    expect(complete.availableChainAccounts.map(item => item.chain.family)).toEqual(['evm'])
    expect(receive.availableChainAccounts.map(item => item.chain.family)).toEqual([
      'evm',
      'bitcoin'
    ])
  })

  test('fails closed for an unknown hardware vendor', async () => {
    const activeSnapshot = snapshot()
    const result = await loadActiveReceiveWalletSet({
      repository: repository({
        ...activeSnapshot,
        keyDomains: activeSnapshot.keyDomains.map(keyDomain => ({
          ...keyDomain,
          source: {
            kind: 'hardware',
            vendor: 'unknown',
            firmwareProfile: 'unknown',
            capabilities: ['zcash']
          }
        }))
      }),
      chainRegistry: activeAddressRegistry(['chain.zcash', 'chain.evm', 'chain.bitcoin'])
    })

    expect(result.availableChainAccounts).toEqual([])
  })

  test('excludes chain scopes that the active Keystone firmware cannot sign', () => {
    const activeSnapshot = snapshot()
    const hardwareKeyDomains = activeSnapshot.keyDomains.map(keyDomain => ({
      ...keyDomain,
      source: {
        kind: 'hardware',
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash']
      }
    }))

    expect(
      listKeySourceAllowedAccountScopes({
        keyDomains: hardwareKeyDomains,
        chainAccounts: activeSnapshot.chainAccounts,
        chainId: 'eip155:1',
        family: 'evm'
      })
    ).toEqual([])
    expect(
      listKeySourceAllowedAccountScopes({
        keyDomains: hardwareKeyDomains.map(keyDomain => ({
          ...keyDomain,
          source: {
            kind: 'hardware',
            vendor: 'keystone',
            firmwareProfile: 'cypherpunk',
            capabilities: ['zcash', 'bitcoin']
          }
        })),
        chainAccounts: activeSnapshot.chainAccounts,
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        family: 'bitcoin'
      })
    ).toEqual([{ keyDomainId: 'wallet:1', accountId: 'account:1:0' }])
    expect(
      listKeySourceAllowedAccountScopes({
        keyDomains: hardwareKeyDomains,
        chainAccounts: activeSnapshot.chainAccounts,
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        family: 'bitcoin'
      })
    ).toEqual([])
    expect(
      listKeySourceAllowedAccountScopes({
        keyDomains: activeSnapshot.keyDomains,
        chainAccounts: activeSnapshot.chainAccounts,
        chainId: 'eip155:1',
        family: 'evm'
      })
    ).toEqual([{ keyDomainId: 'wallet:1', accountId: 'account:1:0' }])
  })

  test('returns no active chain source when the generation has no active Account', async () => {
    const activeSnapshot = snapshot()
    const result = await loadActiveWalletSet({
      repository: repository({
        ...activeSnapshot,
        manifest: { ...activeSnapshot.manifest, activeAccount: undefined }
      }),
      chainRegistry: activeRegistry()
    })

    expect(result.activeAccount).toBeNull()
    expect(result.availableChainAccounts).toEqual([])
  })

  test('returns null only when Storage V2 has no active generation', async () => {
    const result = await loadActiveWalletSet({
      repository: {
        async getActivePointer() {
          return null
        },
        async getSnapshot() {
          throw new Error('getSnapshot must not run')
        }
      },
      chainRegistry: activeRegistry()
    })

    expect(result).toBeNull()
  })

  test('fails closed for a missing or pointer-mismatched active generation', async () => {
    await expect(
      loadActiveWalletSet({
        repository: repository(null),
        chainRegistry: activeRegistry()
      })
    ).rejects.toThrow(/generation is missing/)
    await expect(
      loadActiveWalletSet({
        repository: repository(snapshot(), {
          sourceFingerprint: 'storage-v2:fingerprint:other'
        }),
        chainRegistry: activeRegistry()
      })
    ).rejects.toThrow(/does not match/)
    await expect(
      loadActiveWalletSet({
        repository: repository(snapshot({ manifest: { status: 'staged' } })),
        chainRegistry: activeRegistry()
      })
    ).rejects.toThrow(/does not match/)
    await expect(
      loadActiveWalletSet({
        repository: repository({ ...snapshot(), keyDomains: [] }),
        chainRegistry: activeRegistry()
      })
    ).rejects.toThrow(/unknown KeyDomain|KeyDomain metadata is missing or ambiguous/)
  })

  test('fails closed when a released ChainAccount is not usable for receive', async () => {
    const activeSnapshot = snapshot()
    await expect(
      loadActiveWalletSet({
        repository: repository({ ...activeSnapshot, addresses: [] }),
        chainRegistry: activeRegistry()
      })
    ).rejects.toThrow(/preferred receive Address/)
  })

  test('keeps the reader independent from secrets, V1, Chrome, WASM, and UI', () => {
    const source = readFileSync(
      new URL('../../../src/core/accounts/application/active-wallet-set.ts', import.meta.url),
      'utf8'
    )

    expect(source).not.toMatch(
      /mnemonic|password|privateKey|zcash-wallet-runtime|chrome\.|wasm|react/i
    )
  })
})
