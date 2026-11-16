import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TOKEN_REGISTRY_CACHE_KEY,
  TOKEN_REGISTRY_URL,
  TokenRegistryClient,
  parseTokenRegistryDocument
} from '../../../src/infrastructure/portfolio/token-registry-client.ts'

const UPDATED_AT = '2026-11-16T00:00:00.000Z'
const ERC20 = 'eip155:1/erc20:0x1111111111111111111111111111111111111111'
const SOLANA =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:So11111111111111111111111111111111111111112'
const NEAR = 'near:testnet/nep141:token.testnet'
const entry = (assetId = ERC20, network = 'mainnet', defaultVisible = true) => ({
  assetId,
  network,
  defaultVisible
})
const document = assets => ({ version: 1, updatedAt: UPDATED_AT, assets })
const response = value =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

function memoryStorage(initial) {
  const data = { ...initial }
  return {
    data,
    async get(key) {
      return { [key]: data[key] }
    },
    async set(items) {
      Object.assign(data, items)
    }
  }
}

test('accepts only canonical Token identities and matching known networks', () => {
  const parsed = parseTokenRegistryDocument(
    document([entry(), entry(SOLANA), entry(NEAR, 'testnet', false)])
  )
  assert.equal(parsed.assets.length, 3)
  assert.equal(parsed.assets[2].defaultVisible, false)

  const invalid = [
    entry(ERC20, 'testnet'),
    entry(ERC20.replace('0x111', '0xABC')),
    entry('eip155:1/erc20:0x0000000000000000000000000000000000000000'),
    entry('eip155:1/slip44:60'),
    entry(SOLANA, 'testnet'),
    entry(SOLANA.replace('So11111111111111111111111111111111111111112', 'not-a-key')),
    entry(NEAR, 'mainnet'),
    entry('near:testnet/nep141:Bad.testnet', 'testnet'),
    entry('near:testnet/nep141:token%5ftestnet', 'testnet'),
    entry('bip122:000000000019d6689c085ae165831e93/slip44:0')
  ]
  for (const bad of invalid) {
    assert.throws(() => parseTokenRegistryDocument(document([bad])), bad.assetId)
  }
  assert.throws(() => parseTokenRegistryDocument(document([entry(), entry()])))
  const futureChain = 'eip155:987654321/erc20:0x2222222222222222222222222222222222222222'
  assert.throws(() =>
    parseTokenRegistryDocument(document([entry(futureChain), entry(futureChain, 'testnet')]))
  )
  assert.throws(() => parseTokenRegistryDocument({ ...document([]), extra: true }))
  assert.throws(() => parseTokenRegistryDocument(document([{ ...entry(), extra: true }])))
  assert.throws(() => parseTokenRegistryDocument({ ...document([]), updatedAt: 'not-a-date' }))
  assert.throws(() => parseTokenRegistryDocument(document(Array(4097).fill(entry()))))
})

test('uses a cached last good registry and keeps it through failed refreshes with backoff', async () => {
  let now = 1_000_000
  let calls = 0
  const initial = document([entry()])
  const storage = memoryStorage({
    [TOKEN_REGISTRY_CACHE_KEY]: {
      document: initial,
      successAt: now - 300_001,
      attemptAt: now - 300_001
    }
  })
  const client = new TokenRegistryClient({
    storage,
    now: () => now,
    fetch: async (_url, init) => {
      calls += 1
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'error')
      assert.equal(init.referrerPolicy, 'no-referrer')
      return response(document([{ ...entry(), defaultVisible: 'yes' }]))
    }
  })
  await client.loadCached()
  assert.deepEqual(client.getEntries('mainnet'), initial.assets)
  assert.equal(await client.refresh(), false)
  assert.deepEqual(client.getEntries('mainnet'), initial.assets)
  assert.equal(calls, 1)
  assert.equal(await client.refresh(), false)
  assert.equal(calls, 1)
  now += 60_001
  assert.equal(await client.refresh(), false)
  assert.equal(calls, 2)
  assert.deepEqual(storage.data[TOKEN_REGISTRY_CACHE_KEY].document.assets, initial.assets)
})

test('deduplicates refresh, ignores stale hydration, and reports only asset content changes', async () => {
  let releaseFetch
  let releaseStorage
  let calls = 0
  let now = 1_000_000
  const stale = document([entry(ERC20, 'mainnet', false)])
  const fresh = document([entry()])
  const storage = memoryStorage()
  const staleSnapshot = {
    [TOKEN_REGISTRY_CACHE_KEY]: { document: stale, successAt: 1, attemptAt: 1 }
  }
  let firstRead = true
  storage.get = async () => {
    if (!firstRead) return staleSnapshot
    firstRead = false
    return new Promise(resolve => {
      releaseStorage = () => resolve(staleSnapshot)
    })
  }
  const client = new TokenRegistryClient({
    storage,
    now: () => now,
    fetch: async (url, init) => {
      calls += 1
      assert.equal(url, TOKEN_REGISTRY_URL)
      assert.equal(init.method, 'GET')
      if (calls > 1) return response(fresh)
      return new Promise(resolve => {
        releaseFetch = () => resolve(response(fresh))
      })
    }
  })
  const hydration = client.loadCached()
  const first = client.refresh()
  const second = client.refresh()
  releaseFetch()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(calls, 1)
  releaseStorage()
  await hydration
  assert.deepEqual(client.getEntries('mainnet'), fresh.assets)
  await client.loadCached()
  assert.deepEqual(client.getEntries('mainnet'), fresh.assets)
  assert.equal(await client.refresh(), false)
  assert.equal(calls, 1)
  now += 300_001
  assert.equal(await client.refresh(), false)
  assert.equal(calls, 2)
  assert.deepEqual(client.getEntries('mainnet'), fresh.assets)
})

test('rejects oversized responses without replacing the last good registry', async () => {
  const good = document([entry()])
  let oversized = false
  const client = new TokenRegistryClient({
    storage: memoryStorage(),
    fetch: async () =>
      oversized
        ? new Response(JSON.stringify({ ...good, padding: 'x'.repeat(1024 * 1024) }))
        : response(good)
  })
  assert.equal(await client.refresh(), true)
  oversized = true
  assert.equal(await client.refresh(true), false)
  assert.deepEqual(client.getEntries('mainnet'), good.assets)
})
