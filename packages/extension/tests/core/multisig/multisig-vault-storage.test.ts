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

let env: ReturnType<typeof installStorageEnv>

beforeEach(() => {
  env = installStorageEnv()
})

afterEach(() => {
  env.restore()
})

type StorageArea = { set: (items: Record<string, unknown>) => Promise<void> }

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
