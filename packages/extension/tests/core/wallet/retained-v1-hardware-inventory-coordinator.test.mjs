import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createMultiAccountsHardwareCredential } from '../../../src/core/wallet/hardware-wallet-data.ts'
import { KeystoneHardwareProvisioningCoordinator } from '../../../src/infrastructure/keyring/keystone-hardware-provisioning-coordinator.ts'
import { RetainedV1HardwareInventoryCoordinator } from '../../../src/infrastructure/keyring/migration/retained-v1-hardware-inventory-coordinator.ts'
import { discoverV1Metadata } from '../../../src/infrastructure/persistence/migrations/v1-metadata-discovery.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'

const PASSWORD = 'global-hardware-password'
const CREATED_AT = 1_700_000_000_000
const PUBLIC_KEY = '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f'
const ADDRESSES = Object.freeze({
  transparent: 't1-keystone-fixture',
  shielded: 'u1-keystone-shielded-fixture',
  fullUnified: 'u1-keystone-full-unified-fixture'
})
const ENVELOPE = Object.freeze({
  encryptedData: 'Zml4dHVyZS1jaXBoZXJ0ZXh0',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iv: 'AAAAAAAAAAAAAAAA'
})
const CHAINS = Object.freeze({
  zcashNetwork: 'mainnet',
  zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  evmChainId: 'eip155:1',
  bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
})

class MemoryStorageV2Repository {
  constructor() {
    this.pointer = null
    this.snapshots = new Map()
    this.commits = []
  }

  async getActivePointer() {
    return this.pointer
  }

  async getSnapshot(generationId) {
    return this.snapshots.get(generationId) ?? null
  }

  async stage(snapshot) {
    const current = this.snapshots.get(snapshot.manifest.generationId)
    if (current && JSON.stringify(current) !== JSON.stringify(snapshot)) {
      throw new Error('generation conflict')
    }
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }

  async commit(pointer, expectedGenerationId) {
    if ((this.pointer?.generationId ?? null) !== expectedGenerationId) {
      return 'active-generation-changed'
    }
    this.pointer = pointer
    this.commits.push(pointer)
    return 'committed'
  }

  async discardUncommittedGeneration(generationId) {
    if (this.pointer?.generationId === generationId) throw new Error('cannot discard active')
    this.snapshots.delete(generationId)
  }
}

function retainedZcashProfile() {
  const walletId = 'wallet-keystone-zcash'
  const accountId = 'account-keystone-zcash-0'
  return {
    wallet_state: JSON.stringify({
      state: {
        currentWalletId: walletId,
        currentAccountId: accountId,
        currentNetwork: 'mainnet',
        wallets: [
          {
            id: walletId,
            name: 'Keystone Zcash',
            seedPhraseKey: '',
            accounts: [
              {
                id: accountId,
                name: 'Keystone Account',
                addresses: ADDRESSES,
                derivationIndex: 0,
                birthdayHeight: 2_000_000,
                isPinned: false,
                isHidden: false
              }
            ],
            createdAt: CREATED_AT + 1,
            isPinned: false,
            keySource: 'keystone'
          }
        ],
        accountDisplayNames: {}
      },
      version: 0
    }),
    [`hw_${walletId}`]: ENVELOPE
  }
}

function verifier(overrides = {}) {
  return {
    calls: [],
    async verifyZcash(input) {
      this.calls.push(input)
      return {
        accountIndex: input.account.accountIndex,
        chainId: input.chainId,
        derivationPath: `m/32'/133'/${input.account.accountIndex}'`,
        identity: ADDRESSES.fullUnified,
        ...ADDRESSES,
        ...overrides
      }
    }
  }
}

async function setupActiveMultiCoin() {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorageV2Repository()
  const provisioning = new KeystoneHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => CREATED_AT
  })
  const credential = createMultiAccountsHardwareCredential({
    type: 'multi-accounts',
    masterFingerprintHex: 'e9181cf3',
    keys: [
      {
        publicKeyHex: PUBLIC_KEY,
        derivationPath: "m/44'/60'/0'/0/0",
        sourceFingerprintHex: 'e9181cf3'
      }
    ],
    device: 'Keystone 3 Pro'
  })
  const provisioned = await provisioning.provision({
    credential,
    displayName: 'Keystone Multi-Coin',
    password: PASSWORD,
    network: 'mainnet'
  })
  return { credentialRepository, storageRepository, provisioned }
}

test.describe('Retained V1 hardware inventory coordinator', () => {
  test('atomically appends verified Cypherpunk Zcash without replacing native V2 hardware', async () => {
    const { credentialRepository, storageRepository, provisioned } = await setupActiveMultiCoin()
    const verification = verifier()
    const coordinator = new RetainedV1HardwareInventoryCoordinator({
      credentialRepository,
      storageRepository,
      verifier: verification,
      now: () => CREATED_AT + 2
    })
    const local = retainedZcashProfile()
    const input = {
      discovery: discoverV1Metadata(local),
      credentialEnvelopes: local,
      password: PASSWORD,
      chains: CHAINS
    }

    const result = await coordinator.synchronize(input)
    expect(result).toMatchObject({
      status: 'synchronized',
      addedKeyDomainIds: ['wallet-keystone-zcash']
    })
    expect(verification.calls).toHaveLength(1)
    expect(storageRepository.commits).toHaveLength(2)

    const active = await storageRepository.getSnapshot(result.generationId)
    expect(active.keyDomains.map(keyDomain => keyDomain.id)).toEqual([
      provisioned.keyDomainId,
      'wallet-keystone-zcash'
    ])
    expect(active.manifest.activeAccount).toEqual({
      keyDomainId: 'wallet-keystone-zcash',
      accountId: 'account-keystone-zcash-0'
    })
    expect(active.chainAccounts.map(account => account.scope.chainId)).toEqual([
      'eip155:1',
      CHAINS.zcashChainId
    ])

    await expect(coordinator.synchronize(input)).resolves.toMatchObject({
      status: 'already-synchronized',
      generationId: result.generationId,
      addedKeyDomainIds: []
    })
    expect(storageRepository.commits).toHaveLength(2)
  })

  test('rejects a substituted WASM verification anchor before changing the active pointer', async () => {
    const { credentialRepository, storageRepository, provisioned } = await setupActiveMultiCoin()
    const coordinator = new RetainedV1HardwareInventoryCoordinator({
      credentialRepository,
      storageRepository,
      verifier: verifier({ transparent: 't1-substituted' })
    })
    const local = retainedZcashProfile()

    await expect(
      coordinator.synchronize({
        discovery: discoverV1Metadata(local),
        credentialEnvelopes: local,
        password: PASSWORD,
        chains: CHAINS
      })
    ).rejects.toThrow('Keystone Zcash verification anchor mismatch')
    expect(storageRepository.pointer.generationId).toBe(provisioned.generationId)
    expect(storageRepository.commits).toHaveLength(1)
  })
})
