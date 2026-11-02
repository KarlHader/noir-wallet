import { test } from 'node:test'
import { expect } from '@playwright/test'
import { KEYRING_MAX_UNLOCKED_CREDENTIALS } from '../../../src/core/keyring/ports/index.ts'

import { CredentialSessionHost } from '../../../src/infrastructure/keyring/session/credential-session-host.ts'

const vault = Object.freeze({
  version: 1,
  kdf: 'argon2id',
  kdfParams: Object.freeze({ memoryKib: 19 * 1024, iterations: 2, parallelism: 1 }),
  cipher: 'xchacha20poly1305',
  salt: '00'.repeat(16),
  nonce: '00'.repeat(24),
  ciphertext: '00'.repeat(16)
})
function unlockInput() {
  return {
    password: 'credential-session-password',
    credentials: [
      {
        keyDomainId: 'wallet:1',
        credentialGenerationId: 'credential-generation:1',
        zcashEnvelope: {
          encryptedData: 'AAAAAAAAAAAAAAAAAAAAAA==',
          salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
          iv: 'AAAAAAAAAAAAAAAA'
        },
        multichainVault: vault
      },
      {
        keyDomainId: 'wallet:2',
        credentialGenerationId: 'credential-generation:2',
        zcashEnvelope: {
          encryptedData: 'AAAAAAAAAAAAAAAAAAAAAA==',
          salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
          iv: 'AAAAAAAAAAAAAAAA'
        },
        multichainVault: vault
      }
    ],
    lastUserActivityAt: 900,
    expiresAt: 1_900
  }
}

function createHarness(now = () => 1_000, onUnlock = async () => {}, onZcashBind = async () => {}) {
  const multichainStates = new Map()
  const zcashStates = new Map()
  const zcashBindings = []
  let multichainForceRestarts = 0
  let zcashForceRestarts = 0
  const capsules = {
    async seal(_masterKey, _epoch, _password, credentials) {
      return credentials.map(credential => ({
        schemaVersion: 1,
        keyDomainId: credential.keyDomainId,
        credentialGenerationId: credential.credentialGenerationId,
        iv: new Uint8Array(12).fill(1),
        ciphertext: new Uint8Array(32).fill(2)
      }))
    }
  }
  const multichain = {
    async unlock(input) {
      await onUnlock(input)
      multichainStates.set(input.keyDomainId, {
        credentialGenerationId: input.credentialGenerationId,
        globalUnlockEpoch: input.globalUnlockEpoch,
        state: 'unlocked'
      })
    },
    async getState(input) {
      const state = multichainStates.get(input.keyDomainId)
      return state?.credentialGenerationId === input.credentialGenerationId &&
        state?.globalUnlockEpoch === input.globalUnlockEpoch
        ? state.state
        : 'locked'
    },
    async lockAll() {
      multichainStates.clear()
    },
    forceRestart() {
      multichainForceRestarts += 1
      multichainStates.clear()
    }
  }
  const zcash = {
    async bind(input) {
      await onZcashBind(input)
      zcashStates.clear()
      zcashStates.set(input.keyDomainId, {
        credentialGenerationId: input.credentialGenerationId,
        globalUnlockEpoch: input.globalUnlockEpoch,
        state: 'unlocked'
      })
      zcashBindings.push(input)
    },
    async getState(input) {
      const state = zcashStates.get(input.keyDomainId)
      return state?.credentialGenerationId === input.credentialGenerationId &&
        state?.globalUnlockEpoch === input.globalUnlockEpoch
        ? state.state
        : 'locked'
    },
    async lockAll() {
      zcashStates.clear()
    },
    forceRestart() {
      zcashForceRestarts += 1
      zcashStates.clear()
    }
  }
  let id = 0
  const host = new CredentialSessionHost({
    capsules,
    multichain,
    zcash,
    now,
    createId: () => String(++id)
  })
  return {
    host,
    multichainStates,
    zcashStates,
    zcashBindings,
    getForceRestarts: () => ({ multichainForceRestarts, zcashForceRestarts })
  }
}

test.describe('Offscreen credential session host', () => {
  test('keeps a hardware-only global password session without software engine capsules', async () => {
    const { host } = createHarness()
    const descriptor = await host.unlock({ ...unlockInput(), credentials: [] })

    expect(descriptor.unlockedCredentials).toEqual([])
    await expect(host.attest(descriptor)).resolves.toEqual(descriptor)
    await expect(host.getProvisioningPassword(descriptor)).resolves.toBe(
      'credential-session-password'
    )
  })

  test('publishes a descriptor only after every credential is unlocked', async () => {
    const { host, zcashBindings } = createHarness()
    const descriptor = await host.unlock(unlockInput())

    expect(descriptor.offscreenInstanceId).toBe('offscreen-instance:1')
    expect(descriptor.globalUnlockEpoch).toBe('global-unlock:2')
    expect(descriptor.unlockedCredentials).toEqual([
      { keyDomainId: 'wallet:1', credentialGenerationId: 'credential-generation:1' },
      { keyDomainId: 'wallet:2', credentialGenerationId: 'credential-generation:2' }
    ])
    expect(descriptor.lastUserActivityAt).toBe(1_000)
    expect(descriptor.expiresAt).toBe(2_000)
    await expect(host.attest(descriptor)).resolves.toEqual(descriptor)
    await expect(host.getProvisioningPassword(descriptor)).resolves.toBe(
      'credential-session-password'
    )
    await expect(host.bindZcashCredential(descriptor, 'wallet:2')).resolves.toBeUndefined()
    expect(zcashBindings).toHaveLength(1)
    expect(zcashBindings[0]).toMatchObject({
      keyDomainId: 'wallet:2',
      credentialGenerationId: 'credential-generation:2',
      globalUnlockEpoch: 'global-unlock:2',
      capsule: {
        schemaVersion: 1,
        keyDomainId: 'wallet:2',
        credentialGenerationId: 'credential-generation:2'
      }
    })
    expect(zcashBindings[0].masterKey).toBeInstanceOf(CryptoKey)
    expect(zcashBindings[0]).not.toHaveProperty('mnemonic')
  })

  test('unlocks the maximum credential inventory serially', async () => {
    let activeUnlocks = 0
    let maximumConcurrentUnlocks = 0
    let unlockCalls = 0
    const { host } = createHarness(
      () => 1_000,
      async () => {
        unlockCalls += 1
        activeUnlocks += 1
        maximumConcurrentUnlocks = Math.max(maximumConcurrentUnlocks, activeUnlocks)
        await Promise.resolve()
        activeUnlocks -= 1
      }
    )
    const template = unlockInput()
    const credentials = Array.from({ length: KEYRING_MAX_UNLOCKED_CREDENTIALS }, (_, index) => ({
      ...template.credentials[0],
      keyDomainId: `wallet:${index + 1}`,
      credentialGenerationId: `credential-generation:${index + 1}`
    }))

    const descriptor = await host.unlock({ ...template, credentials })

    expect(descriptor.unlockedCredentials).toHaveLength(KEYRING_MAX_UNLOCKED_CREDENTIALS)
    expect(unlockCalls).toBe(KEYRING_MAX_UNLOCKED_CREDENTIALS)
    expect(maximumConcurrentUnlocks).toBe(1)
  })

  test('updates activity atomically and fails closed for a stale descriptor', async () => {
    const { host } = createHarness()
    const descriptor = await host.unlock(unlockInput())
    const updated = await host.touch({
      expected: descriptor,
      lastUserActivityAt: 1_100,
      expiresAt: 2_100
    })

    expect(updated.lastUserActivityAt).toBe(1_100)
    await expect(host.attest(descriptor)).resolves.toEqual(updated)
    await expect(host.bindZcashCredential(updated, 'wallet:1')).resolves.toBeUndefined()
  })

  test('continues activity from a recoverably stale persisted descriptor', async () => {
    const { host } = createHarness()
    const persisted = await host.unlock(unlockInput())
    const committed = await host.touch({
      expected: persisted,
      lastUserActivityAt: 1_100,
      expiresAt: 2_100
    })

    const refreshed = await host.touch({
      expected: persisted,
      lastUserActivityAt: 1_200,
      expiresAt: 2_200
    })

    expect(committed.lastUserActivityAt).toBe(1_100)
    expect(refreshed.lastUserActivityAt).toBe(1_200)
    expect(refreshed.expiresAt).toBe(2_200)
    await expect(host.attest(refreshed)).resolves.toEqual(refreshed)
  })

  test('fails closed when a persisted descriptor changes session identity or moves forward', async () => {
    const staleHarness = createHarness()
    const descriptor = await staleHarness.host.unlock(unlockInput())
    const updated = await staleHarness.host.touch({
      expected: descriptor,
      lastUserActivityAt: 1_100,
      expiresAt: 2_100
    })

    await expect(
      staleHarness.host.attest({ ...descriptor, globalUnlockEpoch: 'global-unlock:other' })
    ).rejects.toThrow(/mismatch/i)
    await expect(staleHarness.host.attest(updated)).rejects.toThrow(/locked/i)

    const forwardHarness = createHarness()
    const current = await forwardHarness.host.unlock(unlockInput())
    await expect(
      forwardHarness.host.attest({
        ...current,
        lastUserActivityAt: current.lastUserActivityAt + 1,
        expiresAt: current.expiresAt + 1
      })
    ).rejects.toThrow(/mismatch/i)
  })

  test('invalidates capsules and Multichain sessions on Worker reconstruction', async () => {
    const { host, getForceRestarts } = createHarness()
    const descriptor = await host.unlock(unlockInput())

    await host.invalidateForWorkerRestart()

    expect(getForceRestarts()).toEqual({
      multichainForceRestarts: 1,
      zcashForceRestarts: 1
    })
    await expect(host.attest(descriptor)).rejects.toThrow(/locked/i)
    await expect(host.getProvisioningPassword(descriptor)).rejects.toThrow(/locked/i)
  })

  test('locks both engines when Zcash credential binding fails', async () => {
    const { host, multichainStates, zcashStates } = createHarness(
      () => 1_000,
      async () => {},
      async () => {
        throw new Error('Zcash Worker unavailable')
      }
    )
    const descriptor = await host.unlock(unlockInput())

    await expect(host.bindZcashCredential(descriptor, 'wallet:1')).rejects.toThrow(
      /worker unavailable/i
    )
    expect(multichainStates).toHaveProperty('size', 0)
    expect(zcashStates).toHaveProperty('size', 0)
    await expect(host.attest(descriptor)).rejects.toThrow(/locked/i)
  })

  test('cannot recover or extend a session after its deadline', async () => {
    let currentTime = 1_000
    const recoveryHarness = createHarness(() => currentTime)
    const recoveryDescriptor = await recoveryHarness.host.unlock(unlockInput())
    currentTime = recoveryDescriptor.expiresAt

    await expect(recoveryHarness.host.getProvisioningPassword(recoveryDescriptor)).rejects.toThrow(
      /expired/i
    )
    await expect(recoveryHarness.host.attest(recoveryDescriptor)).rejects.toThrow(/locked/i)

    currentTime = 1_000
    const touchHarness = createHarness(() => currentTime)
    const touchDescriptor = await touchHarness.host.unlock(unlockInput())
    currentTime = touchDescriptor.expiresAt

    await expect(
      touchHarness.host.touch({
        expected: touchDescriptor,
        lastUserActivityAt: currentTime,
        expiresAt: currentTime + 1_000
      })
    ).rejects.toThrow(/expired/i)
    await expect(touchHarness.host.attest(touchDescriptor)).rejects.toThrow(/locked/i)
  })
})
