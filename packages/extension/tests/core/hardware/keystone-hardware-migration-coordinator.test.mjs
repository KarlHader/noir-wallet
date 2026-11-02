import { test } from 'node:test'
import { expect } from '@playwright/test'

import { unwrapHardwareCredentialEnvelope } from '../../../src/infrastructure/keyring/credential-envelope-authentication.ts'
import { KeystoneHardwareMigrationCoordinator } from '../../../src/infrastructure/keyring/migration/keystone-hardware-migration-coordinator.ts'
import { decodeV1EncryptedCredentialEnvelope } from '../../../src/infrastructure/keyring/migration/v1-credential-envelope.ts'
import { discoverV1Metadata } from '../../../src/infrastructure/persistence/migrations/v1-metadata-discovery.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'

const PASSWORD = 'keystone-migration-password'
const CREATED_AT = 1_700_000_000_000
const CHAINS = Object.freeze({
  zcashNetwork: 'mainnet',
  zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  evmChainId: 'eip155:1',
  bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
})
const ENVELOPE = Object.freeze({
  encryptedData: 'Zml4dHVyZS1jaXBoZXJ0ZXh0',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iv: 'AAAAAAAAAAAAAAAA'
})
const ADDRESSES = Object.freeze({
  transparent: 't1-keystone-fixture',
  shielded: 'u1-keystone-shielded-fixture',
  fullUnified: 'u1-keystone-full-unified-fixture'
})

function localProfile(accountIndexes = [0], keySource = 'keystone') {
  const walletId = 'wallet-keystone'
  const accounts = accountIndexes.map(index => ({
    id: `account-keystone-${index}`,
    name: `Account ${index + 1}`,
    addresses: ADDRESSES,
    derivationIndex: index,
    birthdayHeight: 2_000_000,
    isPinned: false,
    isHidden: false
  }))
  return {
    wallet_state: JSON.stringify({
      state: {
        currentWalletId: walletId,
        currentAccountId: accounts[0].id,
        currentNetwork: 'mainnet',
        wallets: [
          {
            id: walletId,
            name: 'Keystone Wallet',
            seedPhraseKey: '',
            accounts,
            createdAt: CREATED_AT,
            isPinned: false,
            keySource
          }
        ],
        accountDisplayNames: {}
      },
      version: 0
    }),
    [`hw_${walletId}`]: ENVELOPE
  }
}

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

function input(local = localProfile()) {
  return {
    discovery: discoverV1Metadata(local),
    credentialEnvelopes: local,
    password: PASSWORD,
    chains: CHAINS
  }
}

test.describe('Keystone hardware migration coordinator', () => {
  test('retains Ledger vendor and Zcash-only capability when migrating a V1 wallet', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const verification = verifier()
    const coordinator = new KeystoneHardwareMigrationCoordinator({
      credentialRepository,
      storageRepository,
      verifier: verification,
      now: () => CREATED_AT + 1
    })
    const result = await coordinator.migrate(input(localProfile([0], 'ledger')))
    expect(result.status).toBe('committed')
    expect(verification.calls[0].vendor).toBe('ledger')
    const snapshot = await storageRepository.getSnapshot(result.generationId)
    expect(snapshot.keyDomains[0].source).toMatchObject({
      kind: 'hardware',
      vendor: 'ledger',
      firmwareProfile: 'zcash',
      capabilities: ['zcash']
    })
    const activation = await credentialRepository.validateForActivation(
      snapshot.keyDomains[0].credentialRef,
      snapshot.keyDomains[0].id
    )
    expect(activation.record.manifest.hardware.vendor).toBe('ledger')
  })
  test('atomically commits an authenticated hardware CredentialSet and Zcash account tree', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const verification = verifier()
    const coordinator = new KeystoneHardwareMigrationCoordinator({
      credentialRepository,
      storageRepository,
      verifier: verification,
      now: () => CREATED_AT + 1
    })

    const result = await coordinator.migrate(input())
    expect(result.status).toBe('committed')
    expect(storageRepository.pointer.generationId).toBe(result.generationId)
    expect(storageRepository.commits).toHaveLength(1)
    expect(verification.calls).toHaveLength(1)

    const snapshot = await storageRepository.getSnapshot(result.generationId)
    expect(snapshot.keyDomains[0]).toMatchObject({
      id: 'wallet-keystone',
      source: {
        kind: 'hardware',
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash']
      }
    })
    expect(snapshot.chainAccounts).toHaveLength(1)
    expect(snapshot.chainAccounts[0]).toMatchObject({
      derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
      identity: { value: ADDRESSES.fullUnified }
    })
    expect(snapshot.addresses.map(address => address.value)).toEqual([
      ADDRESSES.fullUnified,
      ADDRESSES.shielded,
      ADDRESSES.transparent
    ])

    const keyDomain = snapshot.keyDomains[0]
    const activation = await credentialRepository.validateForActivation(
      keyDomain.credentialRef,
      keyDomain.id
    )
    expect(activation.record.manifest).toMatchObject({
      source: 'hardware',
      hardware: {
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash']
      }
    })
    const envelope = await credentialRepository.getEnvelope(
      activation.record.manifest.engines.zcash.credentialRef
    )
    const encodedLegacy = await unwrapHardwareCredentialEnvelope(envelope, PASSWORD)
    expect(decodeV1EncryptedCredentialEnvelope(encodedLegacy)).toEqual(ENVELOPE)

    await expect(coordinator.migrate(input())).resolves.toMatchObject({
      status: 'already-committed',
      generationId: result.generationId
    })
    expect(storageRepository.commits).toHaveLength(1)
  })

  test('rejects mismatched verified addresses before any persistent write', async () => {
    const credentialRepository = new InMemoryCredentialRepository()
    const storageRepository = new MemoryStorageV2Repository()
    const coordinator = new KeystoneHardwareMigrationCoordinator({
      credentialRepository,
      storageRepository,
      verifier: verifier({ transparent: 't1-substituted' })
    })

    await expect(coordinator.migrate(input())).rejects.toThrow(
      'Keystone Zcash verification anchor mismatch'
    )
    expect(storageRepository.snapshots.size).toBe(0)
    expect(storageRepository.commits).toEqual([])
  })

  test('rejects legacy hardware Wallets with an ambiguous multi-Account UFVK', async () => {
    const credentialRepository = new Proxy(
      {},
      { get: () => async () => Promise.reject(new Error('repository must not be called')) }
    )
    const storageRepository = new Proxy(
      {},
      { get: () => async () => Promise.reject(new Error('repository must not be called')) }
    )
    const verification = verifier()
    const coordinator = new KeystoneHardwareMigrationCoordinator({
      credentialRepository,
      storageRepository,
      verifier: verification
    })

    await expect(coordinator.migrate(input(localProfile([0, 1])))).rejects.toThrow(
      'require exactly one bound Account'
    )
    expect(verification.calls).toEqual([])
  })

  test('rejects software and hardware mixed inventory before repository side effects', async () => {
    const local = localProfile()
    const state = JSON.parse(local.wallet_state)
    state.state.wallets.push({
      ...state.state.wallets[0],
      id: 'wallet-software',
      name: 'Software Wallet',
      keySource: 'software',
      seedPhraseKey: 'seed_wallet-software',
      accounts: [{ ...state.state.wallets[0].accounts[0], id: 'account-software-0' }]
    })
    local.wallet_state = JSON.stringify(state)
    local['seed_wallet-software'] = ENVELOPE
    const coordinator = new KeystoneHardwareMigrationCoordinator({
      credentialRepository: {},
      storageRepository: {},
      verifier: verifier()
    })

    await expect(coordinator.migrate(input(local))).rejects.toThrow(
      'cannot include software Wallet Sets'
    )
  })
})
