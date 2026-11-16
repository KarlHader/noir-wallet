import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createMultiAccountsHardwareCredential } from '../../../../src/core/wallet/hardware-wallet-data.ts'
import { BitcoinAddressDerivationRouter } from '../../../../src/infrastructure/keyring/bitcoin-address-derivation-router.ts'
import { KeystoneHardwareProvisioningCoordinator } from '../../../../src/infrastructure/keyring/keystone-hardware-provisioning-coordinator.ts'
import { InMemoryCredentialRepository } from '../../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'

const PASSWORD = 'keystone-derivation-password'
const CHAIN_ID = 'bip122:000000000019d6689c085ae165831e93'

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
        publicKeyHex: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
        derivationPath: "m/44'/60'/0'/0/0",
        sourceFingerprintHex: 'e9181cf3'
      },
      {
        publicKeyHex: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
        chainCodeHex: '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
        derivationPath: "m/84'/0'/0'",
        sourceFingerprintHex: 'e9181cf3',
        parentFingerprintHex: '0d5de1d7'
      }
    ]
  })
}

function derivationInput(overrides = {}) {
  return {
    chainId: CHAIN_ID,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 7,
    ...overrides
  }
}

async function setup() {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorageV2Repository()
  const provisioning = new KeystoneHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  })
  const result = await provisioning.provision({
    credential: credential(),
    displayName: 'Keystone Multi-Coin',
    password: PASSWORD,
    network: 'mainnet'
  })
  return { credentialRepository, storageRepository, result }
}

test.describe('Bitcoin address derivation router', () => {
  test('derives hardware receive/change addresses without invoking software WASM', async () => {
    const { credentialRepository, storageRepository, result } = await setup()
    let softwareCalls = 0
    let passwordReads = 0
    const router = new BitcoinAddressDerivationRouter({
      software: {
        async deriveAddress() {
          softwareCalls += 1
          throw new Error('hardware derivation must not invoke software WASM')
        }
      },
      storageRepository,
      credentialRepository,
      credentials: {
        async hasUnlockSession() {
          return true
        },
        async getProvisioningPassword() {
          passwordReads += 1
          return PASSWORD
        }
      },
      network: 'mainnet'
    })

    await expect(
      router.deriveAddress(result.keyDomainId, derivationInput())
    ).resolves.toMatchObject({
      address: 'bc1q0eah0hww85fylk0sff4ehlqcsygm6hmxxrc8tf',
      derivationPath: "m/84'/0'/0'/0/7",
      masterFingerprint: '0xe9181cf3'
    })
    await expect(
      router.deriveAddress(result.keyDomainId, derivationInput({ change: true, addressIndex: 3 }))
    ).resolves.toMatchObject({
      address: 'bc1qx63prc4gz75lt9hye3yn23tms8s6edfk5pa50k',
      derivationPath: "m/84'/0'/0'/1/3"
    })
    expect(softwareCalls).toBe(0)
    expect(passwordReads).toBe(1)
  })

  test('delegates software Wallet derivation and preserves its cancellation signal', async () => {
    const { credentialRepository, storageRepository, result } = await setup()
    const pointer = await storageRepository.getActivePointer()
    const snapshot = await storageRepository.getSnapshot(pointer.generationId)
    storageRepository.snapshots.set(pointer.generationId, {
      ...snapshot,
      keyDomains: snapshot.keyDomains.map(keyDomain => ({
        ...keyDomain,
        source: { kind: 'software', mnemonicWordCount: 24 }
      }))
    })
    const controller = new AbortController()
    let receivedSignal = null
    const expected = Object.freeze({ address: 'software-derived-address' })
    const router = new BitcoinAddressDerivationRouter({
      software: {
        async deriveAddress(keyDomainId, input, signal) {
          expect(keyDomainId).toBe(result.keyDomainId)
          expect(input).toEqual(derivationInput())
          receivedSignal = signal
          return expected
        }
      },
      storageRepository,
      credentialRepository,
      credentials: {
        async hasUnlockSession() {
          throw new Error('software routing must not inspect hardware session state')
        },
        async getProvisioningPassword() {
          throw new Error('software routing must not read the global password')
        }
      },
      network: 'mainnet'
    })

    await expect(
      router.deriveAddress(result.keyDomainId, derivationInput(), controller.signal)
    ).resolves.toBe(expected)
    expect(receivedSignal).toBe(controller.signal)
  })

  test('fails closed when locked, rebound to another Wallet or asked for Taproot', async () => {
    const { credentialRepository, storageRepository, result } = await setup()
    const router = new BitcoinAddressDerivationRouter({
      software: {
        async deriveAddress() {
          throw new Error('must not fall back to software')
        }
      },
      storageRepository,
      credentialRepository,
      credentials: {
        async hasUnlockSession() {
          return false
        },
        async getProvisioningPassword() {
          return PASSWORD
        }
      },
      network: 'mainnet'
    })

    await expect(router.deriveAddress(result.keyDomainId, derivationInput())).rejects.toThrow(
      /locked/
    )
    await expect(router.deriveAddress('key-domain:another', derivationInput())).rejects.toThrow(
      /active Wallet/
    )

    const unlocked = new BitcoinAddressDerivationRouter({
      software: {
        async deriveAddress() {
          throw new Error('must not fall back to software')
        }
      },
      storageRepository,
      credentialRepository,
      credentials: {
        async hasUnlockSession() {
          return true
        },
        async getProvisioningPassword() {
          return PASSWORD
        }
      },
      network: 'mainnet'
    })
    await expect(
      unlocked.deriveAddress(result.keyDomainId, derivationInput({ addressType: 'p2tr' }))
    ).rejects.toThrow(/request is invalid/)
  })
})
