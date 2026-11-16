import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createMultiAccountsHardwareCredential } from '../../../src/core/wallet/hardware-wallet-data.ts'
import { KeystoneHardwareProvisioningCoordinator } from '../../../src/infrastructure/keyring/keystone-hardware-provisioning-coordinator.ts'
import { KeystoneEvmSigningContextResolver } from '../../../src/infrastructure/keyring/keystone-evm-signing-context.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'

const PASSWORD = 'keystone-evm-signing-password'

class MemoryStorageV2Repository {
  constructor() {
    this.pointer = null
    this.snapshots = new Map()
  }

  async getActivePointer() {
    return this.pointer
  }

  async getSnapshot(generationId) {
    return this.snapshots.get(generationId) ?? null
  }

  async stage(snapshot) {
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }

  async commit(pointer, expectedGenerationId) {
    if ((this.pointer?.generationId ?? null) !== expectedGenerationId) {
      return 'active-generation-changed'
    }
    this.pointer = pointer
    return 'committed'
  }

  async discardUncommittedGeneration(generationId) {
    this.snapshots.delete(generationId)
  }
}

function credential() {
  return createMultiAccountsHardwareCredential({
    type: 'multi-accounts',
    masterFingerprintHex: 'e9181cf3',
    keys: [
      {
        publicKeyHex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        derivationPath: "m/44'/60'/0'/0/0",
        sourceFingerprintHex: 'e9181cf3'
      }
    ]
  })
}

async function setup() {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorageV2Repository()
  const provisioning = new KeystoneHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  })
  await provisioning.provision({
    credential: credential(),
    displayName: 'Keystone Multi-Coin',
    password: PASSWORD,
    network: 'mainnet'
  })
  const pointer = await storageRepository.getActivePointer()
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  const chainAccount = snapshot.chainAccounts.find(item => item.scope.chainId === 'eip155:1')
  if (!chainAccount) throw new Error('Provisioned EVM ChainAccount is missing')
  return { credentialRepository, storageRepository, chainAccount }
}

test.describe('Keystone EVM signing context', () => {
  test('authenticates the stored public export and returns its exact path, address and fingerprint', async () => {
    const { credentialRepository, storageRepository, chainAccount } = await setup()
    let passwordReads = 0
    const resolver = new KeystoneEvmSigningContextResolver({
      credentialRepository,
      storageRepository,
      credentials: {
        hasUnlockSession: async () => true,
        getProvisioningPassword: async () => {
          passwordReads += 1
          return PASSWORD
        }
      },
      network: 'mainnet'
    })
    await expect(resolver.resolve(chainAccount)).resolves.toEqual({
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
    })
    await expect(resolver.resolve(chainAccount)).resolves.toMatchObject({
      address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
    })
    expect(passwordReads).toBe(1)
  })

  test('fails closed while locked or when the active ChainAccount was substituted', async () => {
    const { credentialRepository, storageRepository, chainAccount } = await setup()
    const locked = new KeystoneEvmSigningContextResolver({
      credentialRepository,
      storageRepository,
      credentials: {
        hasUnlockSession: async () => false,
        getProvisioningPassword: async () => PASSWORD
      },
      network: 'mainnet'
    })
    await expect(locked.resolve(chainAccount)).rejects.toThrow(/locked/)

    const unlocked = new KeystoneEvmSigningContextResolver({
      credentialRepository,
      storageRepository,
      credentials: {
        hasUnlockSession: async () => true,
        getProvisioningPassword: async () => PASSWORD
      },
      network: 'mainnet'
    })
    await expect(
      unlocked.resolve({
        ...chainAccount,
        identity: { ...chainAccount.identity, value: '0x1111111111111111111111111111111111111111' }
      })
    ).rejects.toThrow(/metadata mismatch/)
  })
})
