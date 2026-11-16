import { test } from 'node:test'
import { expect } from '@playwright/test'
import { replaceV1CredentialPassword } from '../../../src/core/wallet/v1-password-change.ts'
import { replaceRetainedV1Envelopes } from '../../../src/infrastructure/keyring/migration/retained-v1-password-change.ts'

function fakeStorage(initial, { corruptReplacement = false, failRollback = false } = {}) {
  let values = structuredClone(initial)
  let writes = 0
  return {
    adapter: {
      read: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
      encrypt: async (plaintext, password) => ({
        encryptedData: `${password}:${plaintext}`,
        salt: 'salt',
        iv: 'iv'
      }),
      decrypt: async (value, password) => {
        const separator = value.encryptedData.indexOf(':')
        if (separator < 0) throw new Error('invalid')
        if (value.encryptedData.slice(0, separator) !== password) throw new Error('decrypt failed')
        return value.encryptedData.slice(separator + 1)
      },
      write: async next => {
        writes += 1
        if (failRollback && writes === 2) throw new Error('rollback failed')
        values = structuredClone(next)
        if (corruptReplacement && writes === 1) {
          values['seed_wallet:2'] = { encryptedData: 'corrupt', salt: 'salt', iv: 'iv' }
        }
      }
    },
    values: () => structuredClone(values),
    writes: () => writes
  }
}

const credentials = [
  { storageKey: 'seed_wallet:1', plaintext: '{"seedPhrase":"first"}' },
  { storageKey: 'seed_wallet:2', plaintext: '{"seedPhrase":"second"}' }
]
const original = Object.fromEntries(
  credentials.map(credential => [
    credential.storageKey,
    {
      encryptedData: `old-password:${credential.plaintext}`,
      salt: 'salt',
      iv: 'iv'
    }
  ])
)

test.describe('V1 password change transaction', () => {
  test('replaces every retained V1 envelope in one batch and verifies the result', async () => {
    const storage = fakeStorage(original)
    await replaceV1CredentialPassword(credentials, 'old-password', 'new-password', storage.adapter)
    expect(storage.writes()).toBe(1)
    expect(storage.values()).toEqual({
      'seed_wallet:1': {
        encryptedData: 'new-password:{"seedPhrase":"first"}',
        salt: 'salt',
        iv: 'iv'
      },
      'seed_wallet:2': {
        encryptedData: 'new-password:{"seedPhrase":"second"}',
        salt: 'salt',
        iv: 'iv'
      }
    })
  })

  test('restores and verifies every old envelope when post-write verification fails', async () => {
    const storage = fakeStorage(original, { corruptReplacement: true })
    await expect(
      replaceV1CredentialPassword(credentials, 'old-password', 'new-password', storage.adapter)
    ).rejects.toThrow('V1 password change failed')
    expect(storage.writes()).toBe(2)
    expect(storage.values()).toEqual(original)
  })

  test('does not write when the current password cannot verify every envelope', async () => {
    const storage = fakeStorage(original)
    await expect(
      replaceV1CredentialPassword(credentials, 'wrong-password', 'new-password', storage.adapter)
    ).rejects.toThrow('decrypt failed')
    expect(storage.writes()).toBe(0)
    expect(storage.values()).toEqual(original)
  })

  test('never reports a failed rollback as a successful password change', async () => {
    const storage = fakeStorage(original, { corruptReplacement: true, failRollback: true })
    await expect(
      replaceV1CredentialPassword(credentials, 'old-password', 'new-password', storage.adapter)
    ).rejects.toThrow('V1 password change rollback verification failed')
  })
})

function retainedEnvelope(byte) {
  return {
    encryptedData: Buffer.alloc(16, byte).toString('base64'),
    salt: Buffer.alloc(16, byte).toString('base64'),
    iv: Buffer.alloc(12, byte).toString('base64')
  }
}

test.describe('Retained V1 envelope commit', () => {
  const replacements = [
    { storageKey: 'seed_wallet:1', source: retainedEnvelope(1), target: retainedEnvelope(11) },
    { storageKey: 'seed_wallet:2', source: retainedEnvelope(2), target: retainedEnvelope(12) }
  ]

  function storage(initial, failFirstWrite = false) {
    let values = structuredClone(initial)
    let writes = 0
    return {
      adapter: {
        read: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
        write: async next => {
          writes += 1
          if (failFirstWrite && writes === 1) throw new Error('write failed')
          values = { ...values, ...structuredClone(next) }
        }
      },
      values: () => structuredClone(values),
      writes: () => writes
    }
  }

  test('finishes a known partial write and is idempotent', async () => {
    const persisted = storage({
      'seed_wallet:1': replacements[0].target,
      'seed_wallet:2': replacements[1].source
    })
    await expect(replaceRetainedV1Envelopes(replacements, persisted.adapter)).resolves.toBe(
      'replaced'
    )
    await expect(replaceRetainedV1Envelopes(replacements, persisted.adapter)).resolves.toBe(
      'already-replaced'
    )
    expect(persisted.values()).toEqual({
      'seed_wallet:1': replacements[0].target,
      'seed_wallet:2': replacements[1].target
    })
    expect(persisted.writes()).toBe(1)
  })

  test('rejects an envelope that is outside the staged source and target sets', async () => {
    const persisted = storage({
      'seed_wallet:1': retainedEnvelope(99),
      'seed_wallet:2': replacements[1].source
    })
    await expect(replaceRetainedV1Envelopes(replacements, persisted.adapter)).rejects.toThrow(
      'outside the password transaction'
    )
    expect(persisted.writes()).toBe(0)
  })

  test('restores the complete source set when the target batch write fails', async () => {
    const initial = {
      'seed_wallet:1': replacements[0].source,
      'seed_wallet:2': replacements[1].source
    }
    const persisted = storage(initial, true)
    await expect(replaceRetainedV1Envelopes(replacements, persisted.adapter)).rejects.toThrow(
      'replacement failed'
    )
    expect(persisted.values()).toEqual(initial)
    expect(persisted.writes()).toBe(2)
  })
})
