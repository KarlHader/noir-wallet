import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  ChromeConfidentialFundingStore,
  CONFIDENTIAL_BALANCE_CACHE_TTL_MS
} from '../../../src/background/confidential-funding-store.ts'

function storageArea() {
  const values = new Map()
  return {
    values,
    get: async key =>
      key === null
        ? Object.fromEntries(values)
        : values.has(key)
          ? { [key]: structuredClone(values.get(key)) }
          : {},
    set: async entries => {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value))
    },
    remove: async key => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
    }
  }
}

test('expires Confidential balance caches and treats legacy arrays as stale', async () => {
  let now = 10_000
  const local = storageArea()
  const session = storageArea()
  const previousChrome = globalThis.chrome
  globalThis.chrome = { storage: { local, session } }
  try {
    const store = new ChromeConfidentialFundingStore(() => now)
    const balances = [{ tokenId: 'nep141:usdc.omft.near', available: '42', source: 'intents' }]
    await store.putBalances('mainnet', 'wallet:one', 'account:one', balances)
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual(
      balances
    )

    now += CONFIDENTIAL_BALANCE_CACHE_TTL_MS + 1
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual([])

    const [key] = [...local.values.keys()]
    local.values.set(key, structuredClone(balances))
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual([])
  } finally {
    globalThis.chrome = previousChrome
  }
})
