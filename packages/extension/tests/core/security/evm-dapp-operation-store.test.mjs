import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ChromeSessionEvmDAppOperationStore } from '../../../src/background/evm-dapp-operation-store.ts'

function storageHarness(initial = {}) {
  const values = { ...initial }
  return {
    values,
    storage: {
      async get(keys) {
        if (keys === null) return { ...values }
        const requested = Array.isArray(keys) ? keys : [keys]
        return Object.fromEntries(
          requested.filter(key => key in values).map(key => [key, values[key]])
        )
      },
      async set(items) {
        Object.assign(values, items)
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
      }
    }
  }
}

const record = Object.freeze({
  schemaVersion: 1,
  transactionId: 'transaction:evm:dapp-test',
  keyDomainId: 'wallet:test',
  accountId: 'account:test',
  origin: 'https://dapp.example'
})

test('persists dApp operation provenance across service-worker instances and scopes it to Account', async () => {
  const harness = storageHarness()
  await new ChromeSessionEvmDAppOperationStore(harness.storage).put(record)

  const restored = new ChromeSessionEvmDAppOperationStore(harness.storage)
  await expect(restored.listForScope('wallet:test', 'account:test')).resolves.toEqual([record])
  await expect(restored.listForScope('wallet:test', 'account:other')).resolves.toEqual([])

  await restored.delete(record.transactionId)
  await expect(restored.listForScope('wallet:test', 'account:test')).resolves.toEqual([])
})

test('rejects forged origins and storage-key mismatches', async () => {
  const harness = storageHarness()
  const store = new ChromeSessionEvmDAppOperationStore(harness.storage)
  await expect(store.put({ ...record, origin: 'chrome-extension://forged' })).rejects.toThrow(
    /origin/i
  )

  const storedKey = `evm_dapp_operation:${encodeURIComponent(record.transactionId)}`
  harness.values[`evm_dapp_operation:${encodeURIComponent('transaction:evm:other')}`] = record
  expect(storedKey).not.toBe(Object.keys(harness.values)[0])
  await expect(store.listForScope('wallet:test', 'account:test')).rejects.toThrow(/key mismatch/i)
})
