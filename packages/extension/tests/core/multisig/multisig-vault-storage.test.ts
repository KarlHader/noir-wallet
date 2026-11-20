import { afterEach, beforeEach, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import {
  MULTISIG_BANNER_STORAGE_KEY,
  MULTISIG_GROUPS_STORAGE_KEY,
  MULTISIG_VAULT_RECORDS_STORAGE_KEY,
  MULTISIG_CREATION_STORAGE_KEY,
  clearMultisigData,
  type MultisigGroupScope
} from '../../../src/lib/multisig-group-storage'
import {
  deleteMultisigDataForAccount,
  deleteMultisigDataForWallet,
  readVaultRecord,
  saveVaultRecordVerified
} from '../../../src/lib/multisig-vault-storage'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'
import { installStorageEnv, reorderStorageObjectKeys } from './helpers/storage-env'
import {
  readCreationOperation,
  saveCreationOperation
} from '../../../src/lib/multisig-creation-storage'
import {
  MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY,
  MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY,
  readPhoneRecoveryGeneration,
  invalidatePendingPhoneRecoveries,
  readPendingPhoneRecovery,
  savePendingPhoneRecovery,
  removePendingPhoneRecovery,
  type PendingPhoneRecovery
} from '../../../src/lib/multisig-recovery-storage'

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/vault-record-v1.json', import.meta.url), 'utf8')
) as { record: SealedVaultRecord }
const RECORD = fixture.record
const MAINNET_RECORD: SealedVaultRecord = { ...RECORD, network: 'mainnet' }

const TESTNET: MultisigGroupScope = { network: 'testnet', walletId: 'w', accountId: 'a' }
const SECOND: SealedVaultRecord = {
  ...RECORD,
  salt: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
}

const RECOVERY_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_RECOVERY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PREVIOUS_V2 = { ...RECORD, version: 2 as const, ownerWalletId: 'w', accountId: 'a' }
const CANDIDATE_V2 = { ...PREVIOUS_V2, iv: 'AAAAAAAAAAAAAAAA' }
const pendingRecovery = (overrides: Partial<PendingPhoneRecovery> = {}): PendingPhoneRecovery => ({
  scope: TESTNET,
  previous: PREVIOUS_V2,
  candidate: CANDIDATE_V2,
  expiresAt: Date.now() + 60_000,
  contextGeneration: 0,
  ...overrides
})

let env: ReturnType<typeof installStorageEnv>

beforeEach(() => {
  env = installStorageEnv()
})

afterEach(() => {
  env.restore()
})

type StorageArea = { set: (items: Record<string, unknown>) => Promise<void> }

function installSessionStorage(): Map<string, unknown> {
  const store = new Map<string, unknown>()
  const storage = (globalThis as unknown as { chrome: { storage: Record<string, unknown> } }).chrome
    .storage
  storage.session = {
    get: async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter(key => store.has(key))
          .map(key => [key, structuredClone(store.get(key))])
      ),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value))
    },
    remove: async (key: string) => {
      store.delete(key)
    }
  }
  return store
}

function storageArea(): StorageArea {
  return (globalThis as unknown as { chrome: { storage: { local: StorageArea } } }).chrome.storage
    .local
}

/** Replaces the stub's next `set` call only; later calls reach the in-memory store again. */
function overrideNextSet(
  next: (items: Record<string, unknown>, real: StorageArea['set']) => Promise<void>
) {
  const area = storageArea()
  const real = area.set
  area.set = async items => {
    area.set = real
    await next(items, real)
  }
}

function storedVaults(): Record<string, unknown> {
  return (env.store.get(MULTISIG_VAULT_RECORDS_STORAGE_KEY) ?? {}) as Record<string, unknown>
}

function keysOfStored(key: string): string[] {
  const stored = env.store.get(key)
  return stored ? Object.keys(stored as object).sort() : []
}

function seedAll(scopeKeys: { vault: string[]; group: string[]; banner: string[] }): void {
  env.store.set(
    MULTISIG_CREATION_STORAGE_KEY,
    Object.fromEntries(scopeKeys.group.map(key => [key, { future: true }]))
  )
  const vaults: Record<string, SealedVaultRecord> = {}
  for (const key of scopeKeys.vault) {
    vaults[key] = key.startsWith('mainnet:') ? MAINNET_RECORD : RECORD
  }
  env.store.set(MULTISIG_VAULT_RECORDS_STORAGE_KEY, vaults)
  env.store.set(
    MULTISIG_GROUPS_STORAGE_KEY,
    Object.fromEntries(
      scopeKeys.group.map(key => [
        key,
        {
          groupId: 'g',
          threshold: '2-of-3',
          transportKind: 'ble',
          devices: [],
          fingerprint: 'f',
          createdAt: 1,
          mock: true
        }
      ])
    )
  )
  env.store.set(
    MULTISIG_BANNER_STORAGE_KEY,
    Object.fromEntries(scopeKeys.banner.map(key => [key, true]))
  )
}

test.describe('multisig vault storage', () => {
  test('pending phone recovery survives a new caller and uses only its session key', async () => {
    const session = installSessionStorage()
    const pending = pendingRecovery()
    await savePendingPhoneRecovery(RECOVERY_ID, pending)
    const resumed = await import(
      new URL('../../../src/lib/multisig-recovery-storage.ts?resumed=1', import.meta.url).href
    )
    expect(await resumed.readPendingPhoneRecovery(RECOVERY_ID)).toEqual(pending)
    expect(await resumed.readPhoneRecoveryGeneration()).toBe(0)
    expect([...session.keys()]).toEqual([MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY])
    expect(env.store.size).toBe(0)

    const replacement = pendingRecovery()
    await savePendingPhoneRecovery(OTHER_RECOVERY_ID, replacement)
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).toBeNull()
    expect(await readPendingPhoneRecovery(OTHER_RECOVERY_ID)).toEqual(replacement)
  })

  test('context invalidation rejects an in-flight prepare and clears pending recoveries', async () => {
    const session = installSessionStorage()
    const generation = await readPhoneRecoveryGeneration()
    expect(generation).toBe(0)
    await savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery({ contextGeneration: generation }))
    await invalidatePendingPhoneRecoveries()
    expect(await readPhoneRecoveryGeneration()).toBe(1)
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).toBeNull()
    expect(session.get(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY)).toEqual({})
    expect(session.get(MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY)).toBe(1)
    await expect(
      savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery({ contextGeneration: generation }))
    ).rejects.toThrow('context changed')
    const fresh = pendingRecovery({ contextGeneration: 1 })
    await savePendingPhoneRecovery(RECOVERY_ID, fresh)
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).toEqual(fresh)
  })

  test('invalid generation and failed invalidation readback fail closed', async () => {
    const session = installSessionStorage()
    session.set(MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY, -1)
    await expect(readPhoneRecoveryGeneration()).rejects.toThrow()
    await expect(savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery())).rejects.toThrow()
    await expect(invalidatePendingPhoneRecoveries()).rejects.toThrow()

    session.set(MULTISIG_PHONE_RECOVERY_GENERATION_STORAGE_KEY, 0)
    await savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery())
    const area = (globalThis as unknown as { chrome: { storage: { session: StorageArea } } }).chrome
      .storage.session
    const realSet = area.set
    area.set = async () => {}
    await expect(invalidatePendingPhoneRecoveries()).rejects.toThrow('invalidation')
    area.set = realSet
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).not.toBeNull()
  })

  test('saving a recovery prunes expired entries but retains another account', async () => {
    const session = installSessionStorage()
    const otherScope = { ...TESTNET, accountId: 'b' }
    const otherPrevious = { ...PREVIOUS_V2, accountId: 'b' }
    const otherCandidate = { ...CANDIDATE_V2, accountId: 'b' }
    const other = pendingRecovery({
      scope: otherScope,
      previous: otherPrevious,
      candidate: otherCandidate
    })
    await savePendingPhoneRecovery(RECOVERY_ID, other)
    session.set(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY, {
      [RECOVERY_ID]: other,
      [OTHER_RECOVERY_ID]: { ...pendingRecovery(), expiresAt: Date.now() - 1 }
    })
    const nextId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
    await savePendingPhoneRecovery(nextId, pendingRecovery())
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).toEqual(other)
    expect(await readPendingPhoneRecovery(OTHER_RECOVERY_ID)).toBeNull()
    expect(
      Object.keys(session.get(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY) as object).sort()
    ).toEqual([RECOVERY_ID, nextId].sort())
  })

  test('pending phone recovery expires and malformed scope or records cannot be exposed', async () => {
    const session = installSessionStorage()
    const pending = pendingRecovery()
    await savePendingPhoneRecovery(RECOVERY_ID, pending)
    session.set(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY, {
      [RECOVERY_ID]: { ...pending, expiresAt: Date.now() - 1 }
    })
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).toBeNull()

    for (const corrupt of [
      { ...pending, scope: { ...TESTNET, accountId: 'other' } },
      { ...pending, candidate: { ...CANDIDATE_V2, groupId: 'other' } },
      { ...pending, candidate: PREVIOUS_V2 },
      { ...pending, extra: true },
      { ...pending, expiresAt: Infinity }
    ]) {
      session.set(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY, { [RECOVERY_ID]: corrupt })
      await expect(readPendingPhoneRecovery(RECOVERY_ID)).rejects.toThrow()
      await expect(savePendingPhoneRecovery(OTHER_RECOVERY_ID, pendingRecovery())).rejects.toThrow()
      await expect(removePendingPhoneRecovery(RECOVERY_ID)).rejects.toThrow()
    }
  })

  test('pending recovery rejects invalid ids and confirms write and removal readback', async () => {
    const session = installSessionStorage()
    await expect(savePendingPhoneRecovery('not-a-uuid', pendingRecovery())).rejects.toThrow()
    await expect(
      savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery({ candidate: PREVIOUS_V2 }))
    ).rejects.toThrow()
    const area = (
      globalThis as unknown as {
        chrome: { storage: { session: StorageArea & { remove: (key: string) => Promise<void> } } }
      }
    ).chrome.storage.session
    const realSet = area.set
    area.set = async () => {}
    await expect(savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery())).rejects.toThrow()
    area.set = realSet
    await savePendingPhoneRecovery(RECOVERY_ID, pendingRecovery())
    const realRemove = area.remove
    area.remove = async () => {}
    await expect(removePendingPhoneRecovery(RECOVERY_ID)).rejects.toThrow()
    area.remove = realRemove
    await removePendingPhoneRecovery(RECOVERY_ID)
    expect(await readPendingPhoneRecovery(RECOVERY_ID)).toBeNull()
    expect(session.has(MULTISIG_PHONE_RECOVERY_PENDING_STORAGE_KEY)).toBe(false)
  })
  test('creation progress reads back and preserves unknown unrelated records', async () => {
    env.store.set(MULTISIG_CREATION_STORAGE_KEY, { 'testnet:other:future': { version: 9 } })
    const operation = {
      version: 1 as const,
      operationId: 'op',
      scope: TESTNET,
      parentAccountId: 'parent',
      groupId: 'group',
      threshold: '2-of-3' as const,
      birthdayHeight: 123,
      createdAt: 1,
      phase: 'reserved' as const
    }
    overrideNextSet(async (items, real) =>
      real(reorderStorageObjectKeys(items) as Record<string, unknown>)
    )
    await saveCreationOperation(operation)
    expect(await readCreationOperation(TESTNET)).toEqual(operation)
    expect(
      (env.store.get(MULTISIG_CREATION_STORAGE_KEY) as Record<string, unknown>)[
        'testnet:other:future'
      ]
    ).toEqual({ version: 9 })
    overrideNextSet(async (_items, _real) => {})
    await expect(saveCreationOperation({ ...operation, phase: 'share_saved' })).rejects.toThrow(
      'Creation progress could not be saved'
    )
    expect((await readCreationOperation(TESTNET))?.phase).toBe('reserved')

    for (const change of [
      (row: Record<string, unknown>) => ({ ...row, extra: true }),
      (row: Record<string, unknown>) => ({ ...row, birthdayHeight: 124 }),
      (row: Record<string, unknown>) => ({ ...row, birthdayHeight: null }),
      (row: Record<string, unknown>) => ({ ...row, scope: { ...operation.scope, extra: true } }),
      (row: Record<string, unknown>) => ({
        ...row,
        scope: { ...operation.scope, accountId: 'other' }
      }),
      (row: Record<string, unknown>) => {
        const { birthdayHeight: _removed, ...remaining } = row
        return remaining
      }
    ]) {
      overrideNextSet(async (items, real) => {
        const rows = items[MULTISIG_CREATION_STORAGE_KEY] as Record<string, unknown>
        await real({
          [MULTISIG_CREATION_STORAGE_KEY]: {
            ...rows,
            'testnet:w:a': change(rows['testnet:w:a'] as Record<string, unknown>)
          }
        })
      })
      await expect(saveCreationOperation({ ...operation, phase: 'share_saved' })).rejects.toThrow(
        'Creation progress could not be saved'
      )
    }
  })
  test('writes and reads a record per scope', async () => {
    await saveVaultRecordVerified(TESTNET, RECORD)

    await expect(readVaultRecord(TESTNET)).resolves.toEqual(RECORD)
    await expect(readVaultRecord({ ...TESTNET, accountId: 'b' })).resolves.toBeNull()
    await expect(readVaultRecord({ ...TESTNET, walletId: 'w2' })).resolves.toBeNull()
    expect(keysOfStored(MULTISIG_VAULT_RECORDS_STORAGE_KEY)).toEqual(['testnet:w:a'])
  })

  test('a stored entry that fails validation, or disagrees with its scope network, reads as missing', async () => {
    env.store.set(MULTISIG_VAULT_RECORDS_STORAGE_KEY, {
      'testnet:w:a': { ...RECORD, version: 2 }
    })
    await expect(readVaultRecord(TESTNET)).resolves.toBeNull()

    env.store.set(MULTISIG_VAULT_RECORDS_STORAGE_KEY, { 'mainnet:w:a': RECORD })
    await expect(readVaultRecord({ ...TESTNET, network: 'mainnet' })).resolves.toBeNull()
  })

  test('refuses to write a record under another network', async () => {
    await expect(
      saveVaultRecordVerified({ ...TESTNET, network: 'mainnet' }, RECORD)
    ).rejects.toThrow('Invalid vault record')
    await expect(
      saveVaultRecordVerified(TESTNET, { ...RECORD, version: 2 } as never)
    ).rejects.toThrow('Invalid vault record')
    expect(env.store.has(MULTISIG_VAULT_RECORDS_STORAGE_KEY)).toBe(false)
  })

  test('a verified save keeps every other stored entry exactly as stored', async () => {
    const unparsable = { ...RECORD, version: 2 }
    env.store.set(MULTISIG_VAULT_RECORDS_STORAGE_KEY, {
      'testnet:w:b': RECORD,
      'testnet:w:c': unparsable
    })

    await saveVaultRecordVerified(TESTNET, SECOND)

    expect(storedVaults()).toEqual({
      'testnet:w:a': SECOND,
      'testnet:w:b': RECORD,
      'testnet:w:c': unparsable
    })
  })

  test('a failed write leaves the earlier record of the scope in place', async () => {
    await saveVaultRecordVerified(TESTNET, RECORD)
    overrideNextSet(async () => {
      throw new Error('quota')
    })

    await expect(saveVaultRecordVerified(TESTNET, SECOND)).rejects.toThrow('quota')

    expect(storedVaults()).toEqual({ 'testnet:w:a': RECORD })
  })

  test('a read-back that differs restores the earlier record and fails', async () => {
    await saveVaultRecordVerified(TESTNET, RECORD)
    // Stores the written map with the entry under `key` altered, as a faulty storage area might.
    const mutate = (key: string) => (items: Record<string, unknown>, real: StorageArea['set']) => {
      const map = items[MULTISIG_VAULT_RECORDS_STORAGE_KEY] as Record<string, SealedVaultRecord>
      return real({
        [MULTISIG_VAULT_RECORDS_STORAGE_KEY]: {
          ...map,
          [key]: { ...map[key], iv: 'AAAAAAAAAAAAAAAA' }
        }
      })
    }
    overrideNextSet(mutate('testnet:w:a'))

    await expect(saveVaultRecordVerified(TESTNET, SECOND)).rejects.toThrow(
      'Vault record could not be saved'
    )
    expect(storedVaults()).toEqual({ 'testnet:w:a': RECORD })

    const other = { ...TESTNET, accountId: 'b' }
    overrideNextSet(mutate('testnet:w:b'))
    await expect(saveVaultRecordVerified(other, SECOND)).rejects.toThrow(
      'Vault record could not be saved'
    )
    expect(Object.keys(storedVaults())).toEqual(['testnet:w:a'])
  })

  test('two concurrent verified saves for one scope leave exactly one of them', async () => {
    await Promise.all([
      saveVaultRecordVerified(TESTNET, RECORD),
      saveVaultRecordVerified(TESTNET, SECOND)
    ])

    const stored = storedVaults()
    expect(Object.keys(stored)).toEqual(['testnet:w:a'])
    expect([RECORD, SECOND]).toContainEqual(stored['testnet:w:a'])
  })

  test('deleting an account removes its record, group and banner flag on both networks only', async () => {
    seedAll({
      vault: ['testnet:w:a', 'testnet:w:b'],
      group: ['testnet:w:a', 'mainnet:w:a', 'testnet:w:b'],
      banner: ['testnet:w:a', 'mainnet:w:a', 'testnet:w:b']
    })

    await deleteMultisigDataForAccount('w', 'a')

    expect(keysOfStored(MULTISIG_VAULT_RECORDS_STORAGE_KEY)).toEqual(['testnet:w:b'])
    expect(keysOfStored(MULTISIG_GROUPS_STORAGE_KEY)).toEqual(['testnet:w:b'])
    expect(keysOfStored(MULTISIG_BANNER_STORAGE_KEY)).toEqual(['testnet:w:b'])
  })

  test('deleting an account matches exactly, not by prefix', async () => {
    seedAll({
      vault: ['testnet:w:a', 'testnet:w:ab'],
      group: ['testnet:w:a', 'testnet:w:ab'],
      banner: ['testnet:w:a', 'testnet:w:ab']
    })

    await deleteMultisigDataForAccount('w', 'a')

    expect(keysOfStored(MULTISIG_VAULT_RECORDS_STORAGE_KEY)).toEqual(['testnet:w:ab'])
    expect(keysOfStored(MULTISIG_GROUPS_STORAGE_KEY)).toEqual(['testnet:w:ab'])
    expect(keysOfStored(MULTISIG_BANNER_STORAGE_KEY)).toEqual(['testnet:w:ab'])
    expect(keysOfStored(MULTISIG_CREATION_STORAGE_KEY)).toEqual(['testnet:w:ab'])
  })

  test('deleting a wallet leaves a wallet whose id merely starts the same', async () => {
    const keys = ['testnet:w:a', 'testnet:w:b', 'testnet:w2:a']
    seedAll({ vault: keys, group: keys, banner: keys })

    await deleteMultisigDataForWallet('w')

    expect(keysOfStored(MULTISIG_VAULT_RECORDS_STORAGE_KEY)).toEqual(['testnet:w2:a'])
    expect(keysOfStored(MULTISIG_GROUPS_STORAGE_KEY)).toEqual(['testnet:w2:a'])
    expect(keysOfStored(MULTISIG_BANNER_STORAGE_KEY)).toEqual(['testnet:w2:a'])
    expect(keysOfStored(MULTISIG_CREATION_STORAGE_KEY)).toEqual(['testnet:w2:a'])
  })

  test('deleting with nothing to delete leaves storage untouched', async () => {
    await deleteMultisigDataForWallet('w')
    await deleteMultisigDataForAccount('w', 'a')

    expect(env.store.size).toBe(0)
  })

  test('clearMultisigData removes all three keys', async () => {
    seedAll({ vault: ['testnet:w:a'], group: ['testnet:w:a'], banner: ['testnet:w:a'] })
    env.store.set('unrelated', 'kept')

    await clearMultisigData()

    expect(env.store.has(MULTISIG_VAULT_RECORDS_STORAGE_KEY)).toBe(false)
    expect(env.store.has(MULTISIG_GROUPS_STORAGE_KEY)).toBe(false)
    expect(env.store.has(MULTISIG_BANNER_STORAGE_KEY)).toBe(false)
    expect(env.store.has(MULTISIG_CREATION_STORAGE_KEY)).toBe(false)
    expect(env.store.get('unrelated')).toBe('kept')
  })

  test('concurrent writes both land', async () => {
    const scopeA = TESTNET
    const scopeB = { ...TESTNET, accountId: 'b' }

    await Promise.all([
      saveVaultRecordVerified(scopeA, RECORD),
      saveVaultRecordVerified(scopeB, RECORD)
    ])

    await expect(readVaultRecord(scopeA)).resolves.toEqual(RECORD)
    await expect(readVaultRecord(scopeB)).resolves.toEqual(RECORD)
  })

  test('writes fail when lock coordination is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })

    await expect(saveVaultRecordVerified(TESTNET, RECORD)).rejects.toThrow(
      'Multisig storage coordination is unavailable'
    )
  })
})
