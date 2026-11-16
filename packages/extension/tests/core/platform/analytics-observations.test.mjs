import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const now = Date.now()
const storage = {}
globalThis.__APP_VERSION__ = '2.0.0'
globalThis.__BUILD_CHANNEL__ = 'development'
globalThis.__NETWORK_MODE__ = 'mainnet'
globalThis.__CUSTOM_ANALYTICS_PASSWORD__ = 'test-password'
globalThis.__GA_API_SECRET__ = 'test-secret'
globalThis.chrome = {
  storage: {
    local: {
      get: async key => ({ [key]: storage[key] }),
      set: async values => {
        Object.assign(storage, values)
      }
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {} }
  },
  alarms: { create: async () => {}, clear: async () => {} }
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'en-US', userAgent: 'Chrome/150.0 Macintosh' }
})
globalThis.fetch = async () => {
  throw new Error('Unexpected network request')
}

const { observeActivityReceipts, observeZcashReceipts, observePortfolioBalances } =
  await import('../../../src/background/analytics/observations.ts')
const { clearAnalyticsQueue } = await import('../../../src/lib/analytics/client.ts')
after(() => clearAnalyticsQueue())

async function events(name, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = (storage.analytics_collector_outbox_v1?.entries ?? [])
      .map(entry => entry.payload)
      .filter(payload => payload.event_name === name)
    if (found.length >= expected) return found
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return (storage.analytics_collector_outbox_v1?.entries ?? [])
    .map(entry => entry.payload)
    .filter(payload => payload.event_name === name)
}

function zcashReceive(id, timestamp, txHash = id) {
  return {
    id,
    txHash,
    type: 'receive',
    status: 'success',
    network: 'mainnet',
    amount: '1.25',
    fromType: 'shielded',
    timestamp
  }
}

test('persisted Zcash receive baseline excludes history, self output and refresh replays', async () => {
  const scope = { keyDomainId: 'wallet-receipts', accountId: 'account-receipts' }
  const old = zcashReceive('old', now - 86_400_000)
  await observeZcashReceipts(scope, [old], new Set())
  assert.equal((await events('asset_received', 0)).length, 0)
  const incoming = zcashReceive('incoming', now + 1_000)
  const self = zcashReceive('self', now + 2_000, 'own-hash')
  await observeZcashReceipts(scope, [old, incoming, self], new Set(['own-hash']))
  assert.equal((await events('asset_received', 1)).length, 1)
  await observeZcashReceipts(scope, [old, incoming, self], new Set(['own-hash']))
  assert.equal((await events('asset_received', 1)).length, 1)
  const payload = (await events('asset_received', 1))[0]
  assert.equal(payload.output_amount, '1.25')
  assert.equal(payload.chain, 'zcash')
  assert.equal(payload.wallet_address.startsWith('anon_'), true)
  assert.equal(JSON.stringify(payload).includes('incoming'), false)
  assert.equal(JSON.stringify(payload).includes('own-hash'), false)
  assert.equal(JSON.stringify(payload).includes(scope.accountId), false)
})

test('balance snapshots keep exact domains, omit unavailable USD and upgrade quality', async () => {
  const scope = { keyDomainId: 'wallet-balances', accountId: 'account-balances' }
  const assetId = 'eip155:1/slip44:60'
  const asset = {
    asset: { id: assetId, chainId: 'eip155:1' },
    metadata: { decimals: 24, symbol: 'ETH' },
    balance: {
      totalRaw: '6000000000000000000000000',
      mainRaw: '1000000000000000000000000',
      privateRaw: '5000000000000000000000000',
      privateOnchainRaw: '2000000000000000000000000',
      confidentialRaw: '3000000000000000000000000'
    },
    freshness: 'fresh',
    updatedAt: now
  }
  const model = {
    scope,
    status: 'ready',
    assets: [asset],
    confidential: { status: 'ready', assets: [] }
  }
  const unavailablePrices = { quotes: [] }
  await observePortfolioBalances(model, unavailablePrices)
  const unavailable = await events('balance_snapshot', 3)
  assert.equal(unavailable.length, 3)
  assert.equal(
    unavailable.every(payload => payload.usd_amount === ''),
    true
  )
  const prices = { quotes: [{ assetId, priceUsd: '2', freshness: 'fresh' }] }
  await observePortfolioBalances(model, prices)
  const upgraded = await events('balance_snapshot', 6)
  assert.equal(upgraded.length, 6)
  const byDomain = Object.fromEntries(
    upgraded.slice(3).map(payload => [JSON.parse(payload.extra).source_domain, payload.usd_amount])
  )
  assert.deepEqual(byDomain, { public: '2', private: '4', shield: '6' })
  assert.equal(JSON.parse(upgraded[3].extra).chain_scope, 'multichain')
  assert.equal(JSON.parse(upgraded[3].extra).observation_scope, 'active_account')
  await observePortfolioBalances(model, prices)
  assert.equal((await events('balance_snapshot', 6)).length, 6)
})

test('confirmed EVM receipt uses credited amount and never labels an owned transfer external', async () => {
  const scope = { keyDomainId: 'wallet-evm-receipts', accountId: 'account-evm-receipts' }
  const assetId = 'eip155:1/slip44:60'
  const makeItem = (id, timestamp, sender, recipient) => ({
    id,
    source: 'rpc',
    scope,
    kind: 'transfer',
    status: 'final',
    snapshot: {
      direction: 'incoming',
      primaryAmount: { assetId, amountRaw: '1234567890123456789012345' },
      sender: { address: sender },
      recipient: { address: recipient }
    },
    segments: [],
    createdAt: timestamp
  })
  const metadata = [{ asset: { id: assetId }, metadata: { decimals: 24, symbol: 'ETH' } }]
  const prices = { quotes: [{ assetId, priceUsd: '2', freshness: 'fresh' }] }
  await observeActivityReceipts(
    scope,
    [makeItem('old', now - 1_000, '0x1', '0x2')],
    prices,
    metadata
  )
  const incoming = makeItem('new', now + 1_000, '0x1', '0x2')
  const self = makeItem('self', now + 2_000, '0x3', '0x3')
  await observeActivityReceipts(scope, [incoming, self], prices, metadata)
  const received = await events('asset_received', 3)
  assert.equal(received.length, 3)
  assert.equal(received[1].chain, 'evm')
  assert.equal(received[1].output_amount, '1.234567890123456789012345')
  assert.equal(received[1].usd_amount, '2.46913578024691357802469')
  assert.equal(JSON.parse(received[1].extra).transfer_type, 'unknown')
  assert.equal(JSON.parse(received[2].extra).transfer_type, 'self')
  await observeActivityReceipts(scope, [incoming, self], prices, metadata)
  assert.equal((await events('asset_received', 3)).length, 3)
})

test('mixed priced and unpriced balances stay partial until all prices are available', async () => {
  const scope = { keyDomainId: 'wallet-partial', accountId: 'account-partial' }
  const firstId = 'eip155:1/slip44:60'
  const secondId = 'eip155:1/erc20:0x0000000000000000000000000000000000000001'
  const asset = (id, raw) => ({
    asset: { id, chainId: 'eip155:1' },
    metadata: { decimals: 0, symbol: 'TEST' },
    balance: { totalRaw: raw, mainRaw: raw },
    freshness: 'fresh',
    updatedAt: now
  })
  const model = { scope, status: 'ready', assets: [asset(firstId, '2'), asset(secondId, '3')] }
  const before = (await events('balance_snapshot', 6)).length
  await observePortfolioBalances(model, {
    quotes: [{ assetId: firstId, priceUsd: '5', freshness: 'fresh' }]
  })
  const partial = (await events('balance_snapshot', before + 1)).at(-1)
  assert.equal(partial.usd_amount, '10')
  assert.equal(JSON.parse(partial.extra).valuation, 'partial')
  await observePortfolioBalances(model, {
    quotes: [
      { assetId: firstId, priceUsd: '5', freshness: 'fresh' },
      { assetId: secondId, priceUsd: '7', freshness: 'fresh' }
    ]
  })
  const complete = (await events('balance_snapshot', before + 2)).at(-1)
  assert.equal(complete.usd_amount, '31')
  assert.equal(JSON.parse(complete.extra).valuation, 'complete')
})
