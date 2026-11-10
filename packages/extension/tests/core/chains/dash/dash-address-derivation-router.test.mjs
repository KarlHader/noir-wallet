import { test } from 'node:test'
import { expect } from '@playwright/test'
import { HDKey } from '@scure/bip32'

import { createLedgerMultichainHardwareCredential } from '../../../../src/core/wallet/hardware-wallet-data.ts'
import { DashAddressDerivationRouter } from '../../../../src/infrastructure/keyring/dash-address-derivation-router.ts'
import { LedgerHardwareProvisioningCoordinator } from '../../../../src/infrastructure/keyring/ledger-hardware-provisioning-coordinator.ts'
import { InMemoryCredentialRepository } from '../../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'
import { deriveLedgerDashP2pkh } from '../../../../src/lib/ledger/dash-model.ts'

const PASSWORD = 'ledger-dash-derivation-password'
const CHAIN_ID = 'bip122:00000ffd590b1485b3caadc19b22e637'
const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(5))
const accountKey = root.derive("m/44'/5'/0'")
const receive = deriveLedgerDashP2pkh(accountKey.publicExtendedKey, false, 0)
const change = deriveLedgerDashP2pkh(accountKey.publicExtendedKey, true, 3)
const ACCOUNT_FINGERPRINT = `0x${accountKey.fingerprint.toString(16).padStart(8, '0')}`

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

function ledgerCredential() {
  return createLedgerMultichainHardwareCredential({
    deviceModel: 'nanoX',
    deviceName: 'Ledger Public Vector',
    accounts: [
      {
        family: 'dash',
        accountIndex: 0,
        derivationPath: "m/44'/5'/0'",
        network: 'mainnet',
        xpub: accountKey.publicExtendedKey,
        publicKey: `0x${receive.publicKey}`,
        address: receive.address
      }
    ]
  })
}

function derivationInput(overrides = {}) {
  return {
    chainId: CHAIN_ID,
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    ...overrides
  }
}

async function setup() {
  const credentialRepository = new InMemoryCredentialRepository()
  const storageRepository = new MemoryStorageV2Repository()
  const provisioning = new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  })
  const result = await provisioning.provision({
    credential: ledgerCredential(),
    displayName: 'Ledger Dash',
    password: PASSWORD,
    network: 'mainnet'
  })
  return { credentialRepository, storageRepository, result }
}

function hardwareCredentials(unlocked = true) {
  let passwordReads = 0
  return {
    passwordReads: () => passwordReads,
    credentials: {
      async hasUnlockSession() {
        return unlocked
      },
      async getProvisioningPassword() {
        passwordReads += 1
        return PASSWORD
      }
    }
  }
}

test.describe('Dash address derivation router', () => {
  test('derives the imported Ledger receive address without invoking software WASM', async () => {
    const { credentialRepository, storageRepository, result } = await setup()
    let softwareCalls = 0
    const session = hardwareCredentials()
    const router = new DashAddressDerivationRouter({
      software: {
        async deriveAddress() {
          softwareCalls += 1
          throw new Error('hardware derivation must not invoke software WASM')
        }
      },
      storageRepository,
      credentialRepository,
      credentials: session.credentials,
      network: 'mainnet'
    })

    await expect(
      router.deriveAddress(result.keyDomainId, derivationInput())
    ).resolves.toMatchObject({
      address: receive.address,
      publicKey: `0x${receive.publicKey}`,
      scriptPubKey: `0x${receive.scriptPubKeyHex}`,
      derivationPath: "m/44'/5'/0'/0/0",
      derivationScheme: 'bip44',
      addressScheme: 'dash_p2pkh',
      masterFingerprint: ACCOUNT_FINGERPRINT
    })
    await expect(
      router.deriveAddress(result.keyDomainId, derivationInput({ change: true, addressIndex: 3 }))
    ).resolves.toMatchObject({
      address: change.address,
      derivationPath: "m/44'/5'/0'/1/3",
      masterFingerprint: ACCOUNT_FINGERPRINT
    })
    expect(softwareCalls).toBe(0)
    expect(session.passwordReads()).toBe(1)
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
    const router = new DashAddressDerivationRouter({
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

  test('fails closed for a locked Ledger wallet and for Keystone', async () => {
    const { credentialRepository, storageRepository, result } = await setup()
    let softwareCalls = 0
    const locked = new DashAddressDerivationRouter({
      software: {
        async deriveAddress() {
          softwareCalls += 1
          throw new Error('must not fall back to software')
        }
      },
      storageRepository,
      credentialRepository,
      credentials: hardwareCredentials(false).credentials,
      network: 'mainnet'
    })
    await expect(locked.deriveAddress(result.keyDomainId, derivationInput())).rejects.toThrow(
      /locked/
    )

    const pointer = await storageRepository.getActivePointer()
    const snapshot = await storageRepository.getSnapshot(pointer.generationId)
    storageRepository.snapshots.set(pointer.generationId, {
      ...snapshot,
      keyDomains: snapshot.keyDomains.map(keyDomain => ({
        ...keyDomain,
        source: {
          kind: 'hardware',
          vendor: 'keystone',
          firmwareProfile: 'multi-coin',
          capabilities: ['dash']
        }
      }))
    })
    const keystone = new DashAddressDerivationRouter({
      software: {
        async deriveAddress() {
          softwareCalls += 1
          throw new Error('must not fall back to software')
        }
      },
      storageRepository,
      credentialRepository,
      credentials: hardwareCredentials().credentials,
      network: 'mainnet'
    })
    await expect(keystone.deriveAddress(result.keyDomainId, derivationInput())).rejects.toThrow(
      /unavailable/
    )
    expect(softwareCalls).toBe(0)
  })
})
