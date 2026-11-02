import { test } from 'node:test'
import { expect } from '@playwright/test'
import { AutomaticRefreshSession } from '../../../src/popup/services/automatic-refresh-session.ts'

function createStorage(initial = {}) {
  const values = { ...initial }
  return {
    values,
    async get(key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? { [key]: values[key] } : {}
    },
    async set(next) {
      Object.assign(values, next)
    }
  }
}

test('claims each automatic resource once per cooldown window', async () => {
  const session = new AutomaticRefreshSession(createStorage())

  await expect(
    session.claim('wallet-1:account-1', ['eip155:1', 'solana:mainnet'], 1_000, 500)
  ).resolves.toEqual(['eip155:1', 'solana:mainnet'])
  await expect(
    session.claim('wallet-1:account-1', ['eip155:1', 'solana:mainnet'], 1_100, 500)
  ).resolves.toEqual([])
  await expect(session.claim('wallet-1:account-1', ['eip155:1'], 1_500, 500)).resolves.toEqual([
    'eip155:1'
  ])
})

test('persists the cooldown across Popup document lifecycles', async () => {
  const storage = createStorage()
  const firstPopup = new AutomaticRefreshSession(storage)
  const reopenedPopup = new AutomaticRefreshSession(storage)

  await expect(
    firstPopup.claim('wallet-1:account-1', ['near:mainnet'], 10_000, 1_000)
  ).resolves.toEqual(['near:mainnet'])
  await expect(
    reopenedPopup.claim('wallet-1:account-1', ['near:mainnet'], 10_200, 1_000)
  ).resolves.toEqual([])
})

test('releases a failed refresh claim so recovery can retry immediately', async () => {
  const storage = createStorage()
  const session = new AutomaticRefreshSession(storage)

  await expect(session.claim('asset-prices:mainnet', ['quotes'], 15_000, 1_000)).resolves.toEqual([
    'quotes'
  ])
  await session.release('asset-prices:mainnet', ['quotes'], 15_100)
  await expect(session.claim('asset-prices:mainnet', ['quotes'], 15_100, 1_000)).resolves.toEqual([
    'quotes'
  ])
})

test('isolates Accounts and resources while serializing concurrent claims', async () => {
  const session = new AutomaticRefreshSession(createStorage())
  const [first, duplicate] = await Promise.all([
    session.claim('wallet-1:account-1', ['quotes'], 20_000, 1_000),
    session.claim('wallet-1:account-1', ['quotes'], 20_000, 1_000)
  ])

  expect(first).toEqual(['quotes'])
  expect(duplicate).toEqual([])
  await expect(session.claim('wallet-1:account-2', ['quotes'], 20_000, 1_000)).resolves.toEqual([
    'quotes'
  ])
  await expect(session.claim('wallet-1:account-1', ['portfolio'], 20_000, 1_000)).resolves.toEqual([
    'portfolio'
  ])
})

test('falls back to memory when session storage is unavailable', async () => {
  const storage = {
    async get() {
      throw new Error('Extension context invalidated')
    },
    async set() {
      throw new Error('Extension context invalidated')
    }
  }
  const session = new AutomaticRefreshSession(storage)

  await expect(session.claim('wallet-1:account-1', ['quotes'], 30_000, 1_000)).resolves.toEqual([
    'quotes'
  ])
  await expect(session.claim('wallet-1:account-1', ['quotes'], 30_100, 1_000)).resolves.toEqual([])
})

test('keeps a bounded persisted key for a complete endpoint runtime scope', async () => {
  const storage = createStorage()
  const session = new AutomaticRefreshSession(storage)

  await session.claim(`wallet-1:account-1:${'https://rpc.example/'.repeat(200)}`, ['eip155:1'])
  const snapshot = storage.values.popup_automatic_refresh_attempts_v1
  expect(Object.keys(snapshot.attempts)).toHaveLength(1)
  expect(Object.keys(snapshot.attempts)[0].length).toBeLessThan(64)
})
