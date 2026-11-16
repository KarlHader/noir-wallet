import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createMultiAccountsHardwareCredential } from '../../../src/core/wallet/hardware-wallet-data.ts'
import { unwrapHardwareCredentialEnvelope } from '../../../src/infrastructure/keyring/credential-envelope-authentication.ts'
import { KeystoneHardwareProvisioningCoordinator } from '../../../src/infrastructure/keyring/keystone-hardware-provisioning-coordinator.ts'
import { verifyActiveHardwareCredentialInventory } from '../../../src/infrastructure/keyring/active-hardware-credential-inventory.ts'
import { CredentialPasswordChangeCoordinator } from '../../../src/infrastructure/keyring/migration/credential-password-change-coordinator.ts'
import { readHardwareCredentialEnvelope } from '../../../src/infrastructure/keyring/migration/hardware-credential-password-change.ts'
import { decodeV1EncryptedCredentialEnvelope } from '../../../src/infrastructure/keyring/migration/v1-credential-envelope.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'

const PASSWORD = 'keystone-provisioning-password'
const CREATED_AT = 1_700_000_000_000
const PUBLIC_KEY = '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f'
const SECOND_PUBLIC_KEY = '03f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const CHAIN_CODE = '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88'

class MemoryStorageV2Repository {
  constructor() {
    this.pointer = null
    this.snapshots = new Map()
    this.commits = []
    this.failNextCommit = false
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
    if (this.failNextCommit) {
      this.failNextCommit = false
      throw new Error('injected commit failure')
    }
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

function multiCoinCredential({
  fingerprint = 'e9181cf3',
  publicKey = PUBLIC_KEY,
  device = 'Keystone 3 Pro',
  version = '2.0.0',
  includeBitcoin = true
} = {}) {
  const keys = [
    {
      publicKeyHex: publicKey,
      derivationPath: "m/44'/60'/0'/0/0",
      sourceFingerprintHex: fingerprint
    }
  ]
  if (includeBitcoin) {
    keys.push({
      publicKeyHex: PUBLIC_KEY,
      chainCodeHex: CHAIN_CODE,
      derivationPath: "m/84'/0'/0'",
      sourceFingerprintHex: fingerprint,
      parentFingerprintHex: '0d5de1d7'
    })
  }
  return createMultiAccountsHardwareCredential({
    type: 'multi-accounts',
    masterFingerprintHex: fingerprint,
    keys,
    device,
    version
  })
}

function setup() {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorageV2Repository()
  const coordinator = new KeystoneHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => CREATED_AT
  })
  return { coordinator, credentialRepository, storageRepository }
}

function input(credential = multiCoinCredential(), displayName = 'Keystone Multi-Coin') {
  return { credential, displayName, password: PASSWORD, network: 'mainnet' }
}

async function activeSnapshot(storageRepository) {
  const pointer = await storageRepository.getActivePointer()
  expect(pointer).not.toBeNull()
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  expect(snapshot).not.toBeNull()
  return snapshot
}

test.describe('Keystone hardware provisioning coordinator', () => {
  test('atomically provisions EVM and BIP-84 Bitcoin Account 0 from one Multi-Coin QR', async () => {
    const { coordinator, credentialRepository, storageRepository } = setup()
    const credential = multiCoinCredential()

    const result = await coordinator.provision(input(credential))

    expect(result).toMatchObject({ status: 'committed' })
    expect(result.accountIds).toHaveLength(1)
    expect(storageRepository.commits).toHaveLength(1)
    const snapshot = await activeSnapshot(storageRepository)
    expect(snapshot.keyDomains).toHaveLength(1)
    expect(snapshot.keyDomains[0]).toMatchObject({
      id: result.keyDomainId,
      displayName: 'Keystone Multi-Coin',
      source: {
        kind: 'hardware',
        vendor: 'keystone',
        firmwareProfile: 'multi-coin',
        capabilities: ['bitcoin', 'evm']
      }
    })
    expect(snapshot.chainAccounts).toHaveLength(2)
    expect(snapshot.chainAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: expect.objectContaining({ chainId: 'eip155:1' }),
          derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" }
        }),
        expect.objectContaining({
          scope: expect.objectContaining({
            chainId: 'bip122:000000000019d6689c085ae165831e93'
          }),
          derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
        })
      ])
    )
    expect(snapshot.addresses.map(address => address.value)).toEqual([
      '0x9544A821217E12B43B907C12ad1D7A5d557F158e',
      'bc1qz7qjtsx3lq5hvf8xn0ac62uy4cs7j9vvtyva0c'
    ])

    const activation = await credentialRepository.validateForActivation(
      snapshot.keyDomains[0].credentialRef,
      result.keyDomainId
    )
    expect(activation.status).toBe('active')
    const envelope = await credentialRepository.getEnvelope(
      activation.record.manifest.engines.multichain.credentialRef
    )
    const legacy = decodeV1EncryptedCredentialEnvelope(
      await unwrapHardwareCredentialEnvelope(envelope, PASSWORD)
    )
    await expect(readHardwareCredentialEnvelope(legacy, PASSWORD)).resolves.toEqual(credential)
  })

  test('atomically provisions every configured EVM network for a Multi-Coin Wallet', async () => {
    const { coordinator, storageRepository } = setup()
    await coordinator.provision({
      ...input(),
      evmChainIds: ['eip155:1', 'eip155:56', 'eip155:31337']
    })

    const snapshot = await activeSnapshot(storageRepository)
    const evmAccounts = snapshot.chainAccounts.filter(account =>
      account.scope.chainId.startsWith('eip155:')
    )
    expect(evmAccounts.map(account => account.scope.chainId)).toEqual([
      'eip155:1',
      'eip155:56',
      'eip155:31337'
    ])
    expect(new Set(evmAccounts.map(account => account.identity.value))).toEqual(
      new Set(['0x9544A821217E12B43B907C12ad1D7A5d557F158e'])
    )
    expect(snapshot.manifest.counts).toMatchObject({ chainAccounts: 4, addresses: 4 })
  })

  test('is idempotent across firmware metadata updates and rejects a wrong password', async () => {
    const { coordinator, storageRepository } = setup()
    const first = await coordinator.provision(input())
    const updatedMetadata = multiCoinCredential({ device: 'Keystone 3', version: '2.1.0' })

    await expect(
      coordinator.provision({ ...input(updatedMetadata), password: 'wrong-password' })
    ).rejects.toThrow(/password|authentication/i)
    await expect(coordinator.provision(input(updatedMetadata))).resolves.toMatchObject({
      status: 'already-committed',
      keyDomainId: first.keyDomainId,
      transactionId: first.transactionId
    })
    expect(storageRepository.commits).toHaveLength(1)
  })

  test('authenticates the global password for a hardware-only active Wallet', async () => {
    const { coordinator, credentialRepository, storageRepository } = setup()
    await coordinator.provision(input())
    const snapshot = await activeSnapshot(storageRepository)

    await expect(
      verifyActiveHardwareCredentialInventory(credentialRepository, snapshot, PASSWORD)
    ).resolves.toBe(1)
    await expect(
      verifyActiveHardwareCredentialInventory(credentialRepository, snapshot, 'wrong-password')
    ).rejects.toThrow(/authentication|password/i)
  })

  test('changes a V2-native hardware-only Wallet password without creating retained V1 data', async () => {
    const { coordinator, credentialRepository, storageRepository } = setup()
    await coordinator.provision(input())
    const newPassword = 'updated-keystone-password'
    const passwordChange = new CredentialPasswordChangeCoordinator({
      credentialRepository,
      storageRepository,
      compatibilityWorker: {
        async migrate() {
          throw new Error('hardware-only password change must not invoke the software Worker')
        }
      },
      now: () => CREATED_AT + 1
    })

    const result = await passwordChange.changePassword({
      discovery: {
        status: 'empty',
        source: 'none',
        currentWalletId: null,
        currentAccountId: null,
        wallets: [],
        issues: []
      },
      credentialEnvelopes: {},
      currentPassword: PASSWORD,
      newPassword,
      chains: {
        zcashNetwork: 'mainnet',
        zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        evmChainId: 'eip155:1',
        bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
      }
    })

    expect(result.status).toBe('committed')
    const snapshot = await activeSnapshot(storageRepository)
    await expect(
      verifyActiveHardwareCredentialInventory(credentialRepository, snapshot, PASSWORD)
    ).rejects.toThrow()
    await expect(
      verifyActiveHardwareCredentialInventory(credentialRepository, snapshot, newPassword)
    ).resolves.toBe(1)
  })

  test('preserves the first hardware Wallet and returns the exact second Wallet identity', async () => {
    const { coordinator, storageRepository } = setup()
    const first = await coordinator.provision(input())
    const secondCredential = multiCoinCredential({
      fingerprint: '01020304',
      publicKey: SECOND_PUBLIC_KEY,
      includeBitcoin: false
    })
    const second = await coordinator.provision(input(secondCredential, 'Second Keystone'))

    expect(second.keyDomainId).not.toBe(first.keyDomainId)
    expect(second.transactionId).not.toBe(first.transactionId)
    const snapshot = await activeSnapshot(storageRepository)
    expect(snapshot.keyDomains.map(keyDomain => keyDomain.id)).toEqual([
      first.keyDomainId,
      second.keyDomainId
    ])
    expect(snapshot.keyDomains[1].displayName).toBe('Second Keystone')
    expect(snapshot.accounts.filter(account => account.keyDomainId === second.keyDomainId)).toEqual(
      [expect.objectContaining({ id: second.accountIds[0] })]
    )
    expect(storageRepository.commits).toHaveLength(2)
  })

  test('recovers the same journal after an interrupted atomic pointer commit', async () => {
    const { coordinator, credentialRepository, storageRepository } = setup()
    storageRepository.failNextCommit = true

    await expect(coordinator.provision(input())).rejects.toThrow('injected commit failure')
    expect(storageRepository.pointer).toBeNull()
    expect(storageRepository.snapshots.size).toBe(1)
    const incomplete = await credentialRepository.findIncompleteJournal('create')
    expect(incomplete.phase).toBe('committing')

    const recovered = await coordinator.provision(input())
    expect(recovered.status).toBe('committed')
    expect(recovered.transactionId).toBe(incomplete.transactionId)
    expect((await credentialRepository.getJournal(incomplete.transactionId)).phase).toBe('complete')
    expect(storageRepository.commits).toHaveLength(1)
  })

  test('fails before persistence when the export has no supported Account 0', async () => {
    const { coordinator, credentialRepository, storageRepository } = setup()
    const credential = createMultiAccountsHardwareCredential({
      type: 'multi-accounts',
      masterFingerprintHex: 'e9181cf3',
      keys: [
        {
          publicKeyHex: PUBLIC_KEY,
          derivationPath: "m/44'/60'/0'/0/1",
          sourceFingerprintHex: 'e9181cf3'
        }
      ]
    })

    await expect(coordinator.provision(input(credential))).rejects.toThrow(/Account 0/)
    expect(storageRepository.snapshots.size).toBe(0)
    expect(await credentialRepository.findIncompleteJournal('create')).toBeNull()
  })
})
