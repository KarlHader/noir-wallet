import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY,
  BitcoinAccountPreferencesRepository
} from '../../../../src/background/bitcoin-account-preferences.ts'

const scope = Object.freeze({
  network: 'mainnet',
  keyDomainId: 'key-domain:preferences',
  accountId: 'account:preferences:0'
})

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    storage: {
      get: async key => (values.has(key) ? { [key]: values.get(key) } : {}),
      set: async items => {
        for (const [key, value] of Object.entries(items)) values.set(key, value)
      }
    }
  }
}

test('persists one selected Bitcoin address type per network and Account', async () => {
  const memory = memoryStorage()
  const repository = new BitcoinAccountPreferencesRepository(memory.storage)

  await expect(repository.get(scope)).resolves.toBe('p2wpkh')
  await expect(repository.set(scope, 'p2tr')).resolves.toBe('p2tr')
  await expect(repository.get(scope)).resolves.toBe('p2tr')
  await expect(repository.get({ ...scope, network: 'testnet' })).resolves.toBe('p2wpkh')

  const rebuilt = new BitcoinAccountPreferencesRepository(memory.storage)
  await expect(rebuilt.get(scope)).resolves.toBe('p2tr')
})

test('rejects malformed address types and corrupted persisted preferences', async () => {
  const valid = new BitcoinAccountPreferencesRepository(memoryStorage().storage)
  await expect(valid.set(scope, 'unsupported')).rejects.toThrow(/address type/i)

  const corrupted = new BitcoinAccountPreferencesRepository(
    memoryStorage({
      [BITCOIN_ACCOUNT_PREFERENCES_STORAGE_KEY]: {
        schemaVersion: 1,
        selections: { invalid: 'unsupported' }
      }
    }).storage
  )
  await expect(corrupted.get(scope)).rejects.toThrow(/address type/i)
})
