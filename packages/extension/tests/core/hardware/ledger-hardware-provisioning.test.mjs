import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519'
import { utils } from 'near-api-js'
import { createLedgerMultichainHardwareCredential } from '../../../src/core/wallet/ledger-hardware-credential.ts'
import { getZcashChainId } from '../../../src/core/chains/registry/index.ts'
import { encodeSolanaBase58 } from '../../../src/infrastructure/chains/solana/solana-rpc-codecs.ts'
import { LedgerHardwareProvisioningCoordinator } from '../../../src/infrastructure/keyring/ledger-hardware-provisioning-coordinator.ts'
import { CredentialPasswordChangeCoordinator } from '../../../src/infrastructure/keyring/migration/credential-password-change-coordinator.ts'
import { CredentialRemovalCoordinator } from '../../../src/infrastructure/keyring/migration/credential-removal-coordinator.ts'
import { readActiveLedgerHardwareCredential } from '../../../src/infrastructure/keyring/active-hardware-credential-inventory.ts'
import {
  ledgerMultichainCredentialEquals,
  readHardwareCredentialEnvelope
} from '../../../src/infrastructure/keyring/migration/hardware-credential-password-change.ts'
import { InMemoryCredentialRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-credential-repository.ts'
import { SecureStorage } from '../../../src/core/wallet/secure-storage.ts'

class MemoryStorage {
  pointer = null
  snapshots = new Map()
  failCommit = false
  async getActivePointer() {
    return this.pointer
  }
  async getSnapshot(id) {
    return this.snapshots.get(id) ?? null
  }
  async stage(snapshot) {
    const current = this.snapshots.get(snapshot.manifest.generationId)
    if (current && JSON.stringify(current) !== JSON.stringify(snapshot))
      throw new Error('generation conflict')
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }
  async commit(pointer, expected) {
    if (this.failCommit) {
      this.failCommit = false
      throw new Error('injected commit failure')
    }
    if ((this.pointer?.generationId ?? null) !== expected) return 'active-generation-changed'
    this.pointer = pointer
    return 'committed'
  }
  async discardUncommittedGeneration(id) {
    this.snapshots.delete(id)
  }
}

const solanaBytes = ed25519.getPublicKey(new Uint8Array(32).fill(7))
const solanaKey = encodeSolanaBase58(solanaBytes)
const nearBytes = ed25519.getPublicKey(new Uint8Array(32).fill(8))
const solanaAccount = {
  family: 'solana',
  accountIndex: 0,
  derivationPath: "m/44'/501'/0'",
  publicKey: solanaKey,
  address: solanaKey
}
const nearAccount = {
  family: 'near',
  accountIndex: 0,
  derivationPath: "m/44'/397'/0'/0'/1'",
  publicKey: `ed25519:${utils.serialize.base_encode(nearBytes)}`,
  address: Buffer.from(nearBytes).toString('hex')
}
const credential = accounts =>
  createLedgerMultichainHardwareCredential({
    accounts,
    deviceModel: 'nanoX',
    deviceName: 'Ledger Nano X'
  })
const input = value => ({
  credential: value,
  displayName: 'Ledger',
  password: 'test-ledger-password',
  network: 'mainnet'
})

it('adds a chain to the same Ledger KeyDomain and keeps the original account ID', async () => {
  const storageRepository = new MemoryStorage()
  const credentialRepository = new InMemoryCredentialRepository()
  const coordinator = new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  })
  const first = await coordinator.provision(input(credential([solanaAccount])))
  assert.equal(
    (await coordinator.provision(input(credential([solanaAccount])))).status,
    'already-committed'
  )
  const source = await storageRepository.getSnapshot(first.generationId)
  assert.equal(source.chainAccounts.length, 1)
  assert.equal(source.chainAccounts[0].identity.value, solanaKey)

  const expanded = credential([solanaAccount, nearAccount])
  const second = await coordinator.provision({
    ...input(expanded),
    existingKeyDomainId: first.keyDomainId,
    anchorProof: solanaAccount
  })
  const target = await storageRepository.getSnapshot(second.generationId)
  assert.equal(second.keyDomainId, first.keyDomainId)
  assert.deepEqual(second.accountIds, first.accountIds)
  assert.equal(target.chainAccounts.length, 2)
  assert.equal(target.keyDomains.length, 1)
  assert.deepEqual(target.keyDomains[0].source.capabilities, ['solana', 'near'])
  assert.equal(
    (
      await coordinator.provision({
        ...input(expanded),
        existingKeyDomainId: first.keyDomainId,
        anchorProof: solanaAccount
      })
    ).status,
    'already-committed'
  )
  await assert.rejects(
    () =>
      coordinator.provision({
        ...input(credential([nearAccount])),
        existingKeyDomainId: first.keyDomainId,
        anchorProof: nearAccount
      }),
    /anchor|removed|changed/
  )
})

it('projects Zcash onto an existing native Ledger Account without changing its ID', async () => {
  const storageRepository = new MemoryStorage()
  const coordinator = new LedgerHardwareProvisioningCoordinator({
    credentialRepository: new InMemoryCredentialRepository(),
    storageRepository,
    now: () => 1_700_000_000_000
  })
  const first = await coordinator.provision(input(credential([solanaAccount])))
  const zcash = {
    family: 'zcash',
    accountIndex: 0,
    derivationPath: "m/32'/133'/0'",
    network: 'mainnet',
    ufvk: 'uview1test-only',
    accountHdIndex: 0
  }
  const second = await coordinator.provision({
    ...input(credential([solanaAccount, zcash])),
    existingKeyDomainId: first.keyDomainId,
    anchorProof: solanaAccount,
    zcashProjection: {
      accountId: first.accountIds[0],
      accountIndex: 0,
      addresses: {
        fullUnified: 'u1test-only',
        shielded: 'u1shielded-test',
        transparent: 't1test-only'
      }
    }
  })
  assert.deepEqual(second.accountIds, first.accountIds)
  const snapshot = await storageRepository.getSnapshot(second.generationId)
  assert.equal(snapshot.chainAccounts.length, 2)
  assert.equal(snapshot.chainAccounts[1].scope.accountId, first.accountIds[0])
  assert.equal(snapshot.chainAccounts[1].scope.chainId, getZcashChainId('mainnet'))
  assert.deepEqual(snapshot.keyDomains[0].source.capabilities, ['zcash', 'solana'])
})

it('retries a staged Ledger credential after an interrupted pointer commit', async () => {
  const storageRepository = new MemoryStorage()
  const credentialRepository = new InMemoryCredentialRepository()
  const coordinator = new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  })
  storageRepository.failCommit = true
  const request = input(credential([solanaAccount]))
  await assert.rejects(() => coordinator.provision(request), /injected commit failure/)
  assert.equal(await storageRepository.getActivePointer(), null)
  const result = await coordinator.provision(request)
  assert.equal(result.status, 'committed')
  assert.equal((await storageRepository.getActivePointer()).generationId, result.generationId)
})

it('rotates and removes a native Ledger multichain Wallet without changing its account identity', async () => {
  const storageRepository = new MemoryStorage()
  const credentialRepository = new InMemoryCredentialRepository()
  const first = await new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  }).provision(input(credential([solanaAccount, nearAccount])))
  const second = await new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  }).provision(input(credential([nearAccount])))
  const previous = await storageRepository.getSnapshot(second.generationId)
  const rotation = await new CredentialPasswordChangeCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_001
  }).changePassword({
    discovery: { status: 'empty', wallets: [] },
    credentialEnvelopes: {},
    currentPassword: 'test-ledger-password',
    newPassword: 'next-ledger-password',
    chains: {
      zcashNetwork: 'mainnet',
      zcashChainId: getZcashChainId('mainnet'),
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
    }
  })
  const rotated = await storageRepository.getSnapshot(rotation.generationId)
  assert.deepEqual(
    rotated.accounts.map(account => account.id),
    previous.accounts.map(account => account.id)
  )
  assert.deepEqual(
    rotated.chainAccounts.map(account => account.id),
    previous.chainAccounts.map(account => account.id)
  )
  assert.deepEqual(
    (
      await readActiveLedgerHardwareCredential(
        credentialRepository,
        rotated,
        first.keyDomainId,
        'next-ledger-password'
      )
    ).accountExport.accounts,
    [solanaAccount, nearAccount]
  )
  await assert.rejects(() =>
    readActiveLedgerHardwareCredential(
      credentialRepository,
      rotated,
      first.keyDomainId,
      'test-ledger-password'
    )
  )

  const removed = await new CredentialRemovalCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_002
  }).removeWallet(first.keyDomainId)
  const afterRemoval = await storageRepository.getSnapshot(removed.generationId)
  assert.equal(
    afterRemoval.keyDomains.some(domain => domain.id === first.keyDomainId),
    false
  )
  assert.equal(
    afterRemoval.accounts.some(account => account.keyDomainId === first.keyDomainId),
    false
  )
  assert.equal(
    (
      await new CredentialRemovalCoordinator({
        credentialRepository,
        storageRepository
      }).removeWallet(first.keyDomainId)
    ).status,
    'already-removed'
  )
})

it('accepts independent V3 retained encryption only for an identical public inventory', async () => {
  const original = credential([solanaAccount, nearAccount])
  const first = await SecureStorage.encrypt(JSON.stringify(original), 'test-ledger-password')
  const second = await SecureStorage.encrypt(JSON.stringify(original), 'test-ledger-password')
  assert.notEqual(first.encryptedData, second.encryptedData)
  const firstCredential = await readHardwareCredentialEnvelope(first, 'test-ledger-password')
  const secondCredential = await readHardwareCredentialEnvelope(second, 'test-ledger-password')
  assert.equal(ledgerMultichainCredentialEquals(firstCredential, secondCredential), true)
  assert.equal(
    ledgerMultichainCredentialEquals(firstCredential, credential([solanaAccount])),
    false
  )
})

it('rotates an independently encrypted retained Ledger Zcash credential', async () => {
  const storageRepository = new MemoryStorage()
  const credentialRepository = new InMemoryCredentialRepository()
  const coordinator = new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  })
  const original = await coordinator.provision(input(credential([solanaAccount])))
  const zcash = {
    family: 'zcash',
    accountIndex: 0,
    derivationPath: "m/32'/133'/0'",
    network: 'mainnet',
    ufvk: 'uview1test-only',
    accountHdIndex: 0
  }
  const expanded = credential([solanaAccount, zcash])
  const projected = await coordinator.provision({
    ...input(expanded),
    existingKeyDomainId: original.keyDomainId,
    anchorProof: solanaAccount,
    zcashProjection: {
      accountId: original.accountIds[0],
      accountIndex: 0,
      addresses: {
        fullUnified: 'u1test-only',
        shielded: 'u1shielded-test',
        transparent: 't1test-only'
      }
    }
  })
  const retainedKey = `hw_${original.keyDomainId}`
  const retained = {
    [retainedKey]: await SecureStorage.encrypt(JSON.stringify(expanded), 'test-ledger-password')
  }
  const retainedV1Storage = {
    async read(keys) {
      return Object.fromEntries(keys.map(key => [key, retained[key]]))
    },
    async write(values) {
      Object.assign(retained, values)
    }
  }
  const rotationCoordinator = new CredentialPasswordChangeCoordinator({
    credentialRepository,
    storageRepository,
    retainedV1Storage,
    now: () => 1_700_000_000_001
  })
  const rotationInput = {
    discovery: {
      status: 'ready',
      wallets: [
        {
          id: original.keyDomainId,
          keySource: 'ledger',
          credentialStorageKey: retainedKey,
          accounts: [{ id: original.accountIds[0], accountIndex: 0 }]
        }
      ]
    },
    credentialEnvelopes: { ...retained },
    currentPassword: 'test-ledger-password',
    newPassword: 'next-ledger-password',
    chains: {
      zcashNetwork: 'mainnet',
      zcashChainId: getZcashChainId('mainnet'),
      evmChainId: 'eip155:1',
      bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93'
    }
  }
  storageRepository.failCommit = true
  await assert.rejects(
    () => rotationCoordinator.changePassword(rotationInput),
    /injected commit failure/
  )
  assert.equal((await storageRepository.getActivePointer()).generationId, projected.generationId)
  const rotation = await rotationCoordinator.changePassword({
    ...rotationInput,
    credentialEnvelopes: { ...retained }
  })
  const rotated = await storageRepository.getSnapshot(rotation.generationId)
  assert.equal(
    rotated.chainAccounts.length,
    (await storageRepository.getSnapshot(projected.generationId)).chainAccounts.length
  )
  assert.deepEqual(
    (await readHardwareCredentialEnvelope(retained[retainedKey], 'next-ledger-password'))
      .accountExport.accounts,
    expanded.accountExport.accounts
  )
  assert.deepEqual(
    (
      await readActiveLedgerHardwareCredential(
        credentialRepository,
        rotated,
        original.keyDomainId,
        'next-ledger-password'
      )
    ).accountExport.accounts,
    expanded.accountExport.accounts
  )
})
