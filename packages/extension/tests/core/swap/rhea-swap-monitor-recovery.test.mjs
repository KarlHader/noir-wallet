import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  createRheaSwapSignedOrderGraph,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'
import { IndexedDbTransactionRepository } from '../../../src/infrastructure/persistence/repositories/indexed-db-transaction-repository.ts'
import { createStoredTransactionGraphRecord } from '../../../src/infrastructure/persistence/repositories/indexed-db-transaction-database.ts'
import {
  RHEA_SWAP_TRANSACTION_MONITOR_ALARM,
  RheaSwapTransactionMonitor,
  recoverSignedRheaSwapsAndPoll
} from '../../../src/background/rhea-swap-transaction-monitor.ts'
import { ChromeRheaSwapQuoteStore } from '../../../src/background/rhea-swap.ts'
import { resolveRheaSwapCanonicalAssetId } from '../../../src/core/services/rhea-swap/rhea-swap-asset-identity.ts'
import {
  getRheaSwapQuoteDeadline,
  assertRheaSwapSubmissionDeadline,
  isRheaSwapQuoteFresh
} from '../../../src/core/services/rhea-swap/rhea-swap-quote-validity.ts'
import { resolveRheaSwapDestinationIdentity } from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import {
  MemoryRheaSwapQuoteSessionStore,
  RheaSwapService
} from '../../../src/core/services/rhea-swap/rhea-swap-service.ts'

const protocolUsdc = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
const canonicalUsdc = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const scope = {
  accountKey: 'mainnet_wallet:monitor_account:monitor',
  walletId: 'wallet:monitor',
  accountId: 'account:monitor'
}

function storage() {
  const values = new Map()
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (key === null) return Object.fromEntries(values)
          return { [key]: values.get(key) }
        },
        async set(updates) {
          for (const [key, value] of Object.entries(updates)) values.set(key, value)
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
        }
      }
    },
    alarms: {
      async create() {},
      async clear() {}
    }
  }
  return values
}

function transaction() {
  return {
    id: 'tx:zcash-rhea:monitor',
    txHash: 'a'.repeat(64),
    type: 'swap',
    status: 'pending',
    quoteBinding: {
      provider: 'rhea-cross-chain-dex',
      quoteHandle: 'rhea-quote:monitor',
      isCrossChain: true,
      destinationAsset: protocolUsdc,
      destinationChain: 'arb'
    }
  }
}

it('re-arms the one-shot monitor alarm after a transient graph scope failure', async () => {
  storage()
  const scheduled = []
  const cleared = []
  chrome.alarms.create = (name, options) => scheduled.push({ name, options })
  chrome.alarms.clear = name => cleared.push(name)
  let unavailable = true
  const monitor = new RheaSwapTransactionMonitor({
    async retryPendingReports() {
      return false
    }
  })
  monitor.storageRepository = {
    async getActivePointer() {
      if (unavailable) throw new Error('Storage V2 temporarily unavailable')
      return null
    }
  }

  await assert.rejects(monitor.handleAlarm(), /Storage V2 temporarily unavailable/)
  assert.deepEqual(
    scheduled.map(item => item.name),
    [RHEA_SWAP_TRANSACTION_MONITOR_ALARM]
  )
  assert.equal(scheduled[0].options.delayInMinutes > 0, true)

  unavailable = false
  await monitor.handleAlarm()
  assert.deepEqual(cleared, [RHEA_SWAP_TRANSACTION_MONITOR_ALARM])
})

it('schedules a retry when the initial persisted monitor load fails', async () => {
  storage()
  const scheduled = []
  chrome.alarms.create = name => scheduled.push(name)
  const get = chrome.storage.local.get
  let unavailable = true
  chrome.storage.local.get = async key => {
    if (unavailable) throw new Error('Monitor storage temporarily unavailable')
    return get(key)
  }
  const monitor = new RheaSwapTransactionMonitor({
    async retryPendingReports() {
      return false
    }
  })
  monitor.storageRepository = {
    async getActivePointer() {
      return null
    }
  }

  await assert.rejects(monitor.init(), /Monitor storage temporarily unavailable/)
  assert.deepEqual(scheduled, [RHEA_SWAP_TRANSACTION_MONITOR_ALARM])

  unavailable = false
  await monitor.handleAlarm()
  assert.equal(monitor.loaded, true)
})

it('polls after one signed recovery fails and still attempts the other chains', async () => {
  storage()
  const calls = []
  const warnings = []
  const scheduled = []
  const cleared = []
  let resolveClearStarted
  const clearStarted = new Promise(resolve => {
    resolveClearStarted = resolve
  })
  let resolveClear
  chrome.alarms.create = (name, options) => scheduled.push({ name, options })
  chrome.alarms.clear = name => {
    cleared.push(name)
    resolveClearStarted()
    return new Promise(resolve => {
      resolveClear = resolve
    })
  }
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    const recovery = recoverSignedRheaSwapsAndPoll(
      [
        {
          name: 'EVM',
          async recover() {
            calls.push('evm')
            throw new Error('EVM storage unavailable')
          }
        },
        {
          name: 'Solana',
          async recover() {
            calls.push('solana')
          }
        },
        {
          name: 'NEAR',
          async recover() {
            calls.push('near')
          }
        }
      ],
      {
        async handleAlarm() {
          calls.push('monitor')
          await chrome.alarms.clear(RHEA_SWAP_TRANSACTION_MONITOR_ALARM)
        }
      }
    )
    await clearStarted
    assert.deepEqual(scheduled, [])
    resolveClear()
    await recovery
  } finally {
    resolveClear?.()
    console.warn = originalWarn
  }
  assert.deepEqual(calls, ['evm', 'solana', 'near', 'monitor'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /EVM signed recovery failed/)
  assert.deepEqual(cleared, [RHEA_SWAP_TRANSACTION_MONITOR_ALARM])
  assert.deepEqual(
    scheduled.map(item => item.name),
    [RHEA_SWAP_TRANSACTION_MONITOR_ALARM]
  )
  assert.equal(scheduled[0].options.delayInMinutes > 0, true)
})

it('maps supported RHEA destinations to wallet asset identities', () => {
  assert.equal(resolveRheaSwapCanonicalAssetId(protocolUsdc), canonicalUsdc)
  assert.equal(
    resolveRheaSwapCanonicalAssetId('nep141:zec.omft.near'),
    'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
  )
  assert.equal(resolveRheaSwapCanonicalAssetId('unknown:asset'), null)
  assert.equal(resolveRheaSwapCanonicalAssetId(protocolUsdc, 'testnet'), null)
  assert.equal(
    resolveRheaSwapCanonicalAssetId('nep141:example.testnet', 'testnet'),
    'near:testnet/nep141:example.testnet'
  )
  assert.deepEqual(
    resolveRheaSwapDestinationIdentity(
      { assetId: 'nep141:zec.omft.near', tokenListChainId: 900010 },
      null
    ),
    {
      chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
      assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
    }
  )
})

it('uses the earlier of the SDK age limit and provider expiration', () => {
  assert.equal(getRheaSwapQuoteDeadline({ receivedAt: 1_000, expiresAt: 90_000 }), 31_000)
  assert.equal(getRheaSwapQuoteDeadline({ receivedAt: 1_000, expiresAt: 20_000 }), 20_000)
  assert.equal(isRheaSwapQuoteFresh({ receivedAt: 1_000, expiresAt: null }, 30_999), true)
  assert.equal(isRheaSwapQuoteFresh({ receivedAt: 1_000, expiresAt: null }, 31_000), false)
  assert.equal(isRheaSwapQuoteFresh({ receivedAt: 1_000, expiresAt: null }, 31_001), false)
  assert.equal(isRheaSwapQuoteFresh({ receivedAt: 1_000, expiresAt: null }, 999), false)
  assert.equal(isRheaSwapQuoteFresh({ receivedAt: Number.NaN, expiresAt: null }, 1_000), false)
})

it('rejects expired Zcash submissions after signing or queued wallet work', () => {
  assert.doesNotThrow(() => assertRheaSwapSubmissionDeadline(undefined, 31_000))
  assert.doesNotThrow(() => assertRheaSwapSubmissionDeadline(31_000, 30_999))
  for (const [deadline, now] of [
    [31_000, 31_000],
    [31_000, 31_001],
    [NaN, 1_000],
    [Infinity, 1_000]
  ]) {
    assert.throws(() => assertRheaSwapSubmissionDeadline(deadline, now), /quote expired/)
  }
})

it('restores a Zcash swap monitor from its persisted transaction and scope', async () => {
  const values = storage()
  const tx = transaction()
  const monitor = new RheaSwapTransactionMonitor(
    {
      async canRecoverTransactionSubmission() {
        return true
      }
    },
    {
      loadZcashTransactions: async key => (key === scope.accountKey ? [tx] : [])
    }
  )

  assert.equal(await monitor.restorePendingZcashSwaps([scope]), 1)
  assert.deepEqual(values.get('rhea_swap_pending_transactions'), [
    {
      quoteHandle: tx.quoteBinding.quoteHandle,
      accountKey: scope.accountKey,
      walletId: scope.walletId,
      accountId: scope.accountId,
      transactionId: tx.id,
      isCrossChain: true,
      destinationAsset: canonicalUsdc,
      destinationChain: 'arb'
    }
  ])
  assert.equal(await monitor.restorePendingZcashSwaps([scope]), 0)
  assert.equal(
    await monitor.restorePendingZcashSwaps([
      { ...scope, accountKey: 'testnet_wallet:monitor_account:monitor' }
    ]),
    0
  )
  await assert.rejects(
    monitor.add({
      ...values.get('rhea_swap_pending_transactions')[0],
      accountKey: 'testnet_wallet:monitor_account:monitor'
    }),
    /does not match Mainnet/
  )
})

it('settles the original Zcash record and retries reporting without polling a terminal order', async () => {
  const values = storage()
  const tx = transaction()
  const calls = []
  let reportAvailable = false
  const service = {
    async canRecoverTransactionSubmission() {
      return true
    },
    async retryPendingReports() {
      return false
    },
    async recordTransactionSubmission(handle, hash) {
      calls.push(`record:${handle}:${hash}`)
    },
    async reportSubmission() {
      calls.push('report')
      if (!reportAvailable) throw new Error('report unavailable')
    },
    async getOrderStatus() {
      calls.push('status')
      return { status: 'completed', destinationHash: '0x' + 'b'.repeat(64) }
    },
    async discard() {
      calls.push('discard')
    }
  }
  const options = {
    loadZcashTransactions: async () => [tx],
    updateZcashTransaction: async (_key, id, updates) => {
      assert.equal(id, tx.id)
      Object.assign(tx, updates)
    }
  }
  const monitor = new RheaSwapTransactionMonitor(service, options)
  await monitor.restorePendingZcashSwaps([scope])
  const pending = values.get('rhea_swap_pending_transactions')[0]
  await monitor.check(pending)
  assert.equal(tx.status, 'success')
  assert.equal(tx.destinationTxHash, '0x' + 'b'.repeat(64))
  assert.equal(values.get('rhea_swap_pending_transactions')[0].settled, true)
  assert.equal(calls.includes('discard'), false)

  reportAvailable = true
  const resumed = new RheaSwapTransactionMonitor(service, options)
  resumed.storageRepository = {
    async getActivePointer() {
      return null
    }
  }
  await resumed.recheckNow()
  assert.deepEqual(values.get('rhea_swap_pending_transactions'), [])
  assert.equal(calls.filter(call => call === 'status').length, 1)
  assert.equal(calls.filter(call => call === 'report').length, 2)
  assert.equal(calls.filter(call => call === 'discard').length, 1)
})

it('loads a persisted monitor with a legacy RHEA protocol destination', async () => {
  const values = storage()
  const tx = transaction()
  values.set('rhea_swap_pending_transactions', [
    {
      quoteHandle: tx.quoteBinding.quoteHandle,
      accountKey: scope.accountKey,
      walletId: scope.walletId,
      accountId: scope.accountId,
      transactionId: tx.id,
      isCrossChain: true,
      destinationAsset: protocolUsdc
    }
  ])
  const monitor = new RheaSwapTransactionMonitor(
    {
      async retryPendingReports() {
        return false
      }
    },
    { loadZcashTransactions: async () => [] }
  )
  await monitor.restorePendingZcashSwaps([])
  assert.equal(monitor.pending.get(tx.quoteBinding.quoteHandle).destinationAsset, canonicalUsdc)
})

it('keeps both pending jobs when monitor registration overlaps', async () => {
  const values = storage()
  const monitor = new RheaSwapTransactionMonitor({})
  const job = {
    quoteHandle: 'rhea-quote:first',
    ...scope,
    transactionId: 'tx:first',
    isCrossChain: true,
    destinationAsset: canonicalUsdc
  }
  await Promise.all([
    monitor.add(job),
    monitor.add({ ...job, quoteHandle: 'rhea-quote:second', transactionId: 'tx:second' })
  ])
  assert.equal(values.get('rhea_swap_pending_transactions').length, 2)
})

it('retains older quote timing budgets when saving new sessions and rejects invalid timings', async () => {
  const values = storage()
  const legacy = {
    schemaVersion: 1,
    quoteHandle: 'rhea-quote:legacy-timing',
    request: {
      fromChain: '1',
      toChain: 'near',
      tokenIn: { chain: '1', address: `0x${'2'.repeat(40)}` },
      tokenOut: { chain: 'near', address: 'wrap.near' },
      amountIn: '1000000',
      slippageBps: 50,
      sender: `0x${'1'.repeat(40)}`,
      recipient: 'alice.near',
      extensions: { referral: 'noir_swap' },
      quoteWaitingTimeMs: 3000,
      sameChainTimeoutMs: 500,
      crossChainTimeoutMs: 3000
    },
    quoteRaw: {
      isCrossChain: true,
      chainType: 'evm',
      bestQuote: {
        router: 'nearintents',
        amountOut: '2000000000000000000000000',
        minAmountOut: '1900000000000000000000000',
        preSwap: null,
        bridge: null
      }
    },
    receivedAt: 1000,
    expiresAt: 31000
  }
  const key = `rhea_swap_quote:${encodeURIComponent(legacy.quoteHandle)}`
  values.set(key, legacy)
  const store = new ChromeRheaSwapQuoteStore()
  const current = {
    ...legacy,
    quoteHandle: 'rhea-quote:current-timing',
    request: {
      ...legacy.request,
      quoteWaitingTimeMs: 6000,
      sameChainTimeoutMs: 1500,
      crossChainTimeoutMs: 6000
    }
  }
  await store.put(current)
  assert.deepEqual(
    (await new ChromeRheaSwapQuoteStore().get(legacy.quoteHandle)).request,
    legacy.request
  )
  assert.deepEqual((await store.get(current.quoteHandle)).request, current.request)

  for (const [field, value] of [
    ['quoteWaitingTimeMs', -1],
    ['quoteWaitingTimeMs', 1.5],
    ['sameChainTimeoutMs', '3000'],
    ['sameChainTimeoutMs', undefined],
    ['crossChainTimeoutMs', Number.MAX_SAFE_INTEGER + 1]
  ]) {
    await assert.rejects(
      store.put({ ...current, request: { ...current.request, [field]: value } }),
      /Stored RHEA Swap quote timing is invalid/
    )
  }
})

it('clears pending monitoring and RHEA sessions on wallet reset', async () => {
  const values = storage()
  values.set('rhea_swap_quote:rhea-quote:old', { invalid: true })
  values.set('wallet_settings', { networkMode: 'mainnet' })
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  await sessions.put({ schemaVersion: 1, quoteHandle: 'rhea-quote:old' })
  const service = new RheaSwapService({}, sessions)
  const monitor = new RheaSwapTransactionMonitor(service)
  await monitor.add({
    quoteHandle: 'rhea-quote:old',
    ...scope,
    transactionId: 'tx:old',
    isCrossChain: true
  })
  await monitor.clear()
  assert.deepEqual(values.get('rhea_swap_pending_transactions'), [])
  assert.equal(await sessions.get('rhea-quote:old'), null)
  assert.deepEqual(values.get('wallet_settings'), { networkMode: 'mainnet' })

  await new ChromeRheaSwapQuoteStore().clear()
  assert.equal(values.has('rhea_swap_quote:rhea-quote:old'), false)
  assert.deepEqual(values.get('wallet_settings'), { networkMode: 'mainnet' })
})

it('can reset a damaged persisted monitor without parsing its old entries', async () => {
  const values = storage()
  values.set('rhea_swap_pending_transactions', [{ malformed: true }])
  const monitor = new RheaSwapTransactionMonitor({ async clearSessions() {} })
  await monitor.clear()
  assert.deepEqual(values.get('rhea_swap_pending_transactions'), [])
})

it('finds a RHEA quote at the end of a full account graph window', async () => {
  const graphScope = { keyDomainId: 'wallet:window', accountId: 'account:window' }
  const ordinary = createStoredTransactionGraphRecord({
    root: {
      id: 'tx:ordinary',
      scope: graphScope,
      kind: 'transfer',
      status: 'broadcast',
      segmentIds: ['segment:ordinary'],
      createdAt: 2_000,
      updatedAt: 2_000,
      revision: 0
    },
    segments: [
      {
        id: 'segment:ordinary',
        transactionId: 'tx:ordinary',
        role: 'origin',
        target: { kind: 'onchain', chainId: 'eip155:1' },
        status: 'broadcast',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { transactionHash: '0x1234' },
        createdAt: 2_000,
        updatedAt: 2_000,
        revision: 0
      }
    ]
  })
  const binding = {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:oldest',
    executionId: 'execution-oldest',
    router: 'router',
    sourceTarget: '0x2222222222222222222222222222222222222222',
    sender: '0x1111111111111111111111111111111111111111',
    originAmountRaw: '1000',
    expiresAt: 10_000,
    isCrossChain: true,
    origin: {
      chainId: 'eip155:1',
      assetId: 'eip155:1/slip44:60',
      protocolChainId: '1',
      protocolAssetId: 'native'
    },
    destination: {
      chainId: 'zcash:mainnet',
      assetId: 'zcash:mainnet/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
  const oldQuote = createStoredTransactionGraphRecord(
    createRheaSwapSignedOrderGraph({
      transactionId: parseTransactionId('tx:rhea:oldest'),
      scope: graphScope,
      binding,
      orderId: 'order-oldest',
      segmentIds: {
        origin: parseTransactionSegmentId('segment:rhea:origin:oldest'),
        relay: parseTransactionSegmentId('segment:rhea:relay:oldest'),
        destination: parseTransactionSegmentId('segment:rhea:destination:oldest'),
        refund: parseTransactionSegmentId('segment:rhea:refund:oldest')
      },
      now: 1_000
    })
  )
  const records = [
    ...Array.from({ length: 9_999 }, (_, index) => {
      const id = `tx:ordinary:${index}`
      const segmentId = `segment:ordinary:${index}`
      return {
        ...ordinary,
        transactionId: id,
        graph: {
          ...ordinary.graph,
          root: { ...ordinary.graph.root, id, segmentIds: [segmentId] },
          segments: [{ ...ordinary.graph.segments[0], id: segmentId, transactionId: id }]
        }
      }
    }),
    oldQuote
  ]
  const originalIndexedDb = globalThis.indexedDB
  const originalKeyRange = globalThis.IDBKeyRange
  const seen = []
  globalThis.IDBKeyRange = { only: value => value }
  globalThis.indexedDB = {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          transaction() {
            const transaction = {
              objectStore() {
                return {
                  index() {
                    return {
                      getAll(key, limit) {
                        seen.push({ key, limit })
                        const result = {}
                        queueMicrotask(() => {
                          result.result = records.slice(0, limit)
                          result.onsuccess()
                          queueMicrotask(() => transaction.oncomplete())
                        })
                        return result
                      }
                    }
                  }
                }
              }
            }
            return transaction
          },
          close() {}
        }
        request.onsuccess()
      })
      return request
    }
  }
  try {
    const repository = new IndexedDbTransactionRepository({ databaseName: 'test-rhea-window' })
    assert.deepEqual(await repository.listRheaSwapQuoteHandlesByAccountScope(graphScope), [
      'rhea-quote:oldest'
    ])
    assert.deepEqual(seen, [
      { key: JSON.stringify(['wallet:window', 'account:window']), limit: 10_001 }
    ])
  } finally {
    globalThis.indexedDB = originalIndexedDb
    globalThis.IDBKeyRange = originalKeyRange
  }
})

it('discards deleted account quotes while retaining other account sessions and jobs', async () => {
  const values = storage()
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  for (const quoteHandle of ['rhea-quote:graph', 'rhea-quote:pending', 'rhea-quote:other']) {
    await sessions.put({ schemaVersion: 1, quoteHandle })
  }
  const service = new RheaSwapService({}, sessions)
  const monitor = new RheaSwapTransactionMonitor(service)
  monitor.repository = {
    async listRheaSwapQuoteHandlesByAccountScope(accountScope) {
      return accountScope.accountId === 'account:monitor' ? ['rhea-quote:graph'] : []
    }
  }
  for (const [quoteHandle, accountId] of [
    ['rhea-quote:pending', 'account:monitor'],
    ['rhea-quote:other', 'account:other']
  ]) {
    await monitor.add({
      quoteHandle,
      accountKey: `mainnet_wallet:monitor_${accountId}`,
      walletId: 'wallet:monitor',
      accountId,
      transactionId: `tx:${accountId}`,
      isCrossChain: true
    })
  }
  await monitor.removeAccounts('wallet:monitor', ['account:monitor'])
  assert.equal(await sessions.get('rhea-quote:graph'), null)
  assert.equal(await sessions.get('rhea-quote:pending'), null)
  assert.notEqual(await sessions.get('rhea-quote:other'), null)
  assert.deepEqual(
    values.get('rhea_swap_pending_transactions').map(item => item.quoteHandle),
    ['rhea-quote:other']
  )
})

it('retains deleted account monitor jobs when quote disposal fails so removal can retry', async () => {
  const values = storage()
  let fail = true
  const discarded = []
  const monitor = new RheaSwapTransactionMonitor({
    async discard(handle) {
      if (fail) throw new Error('quote store unavailable')
      discarded.push(handle)
    }
  })
  monitor.repository = {
    async listRheaSwapQuoteHandlesByAccountScope() {
      return ['rhea-quote:graph']
    }
  }
  await monitor.add({
    quoteHandle: 'rhea-quote:pending',
    ...scope,
    transactionId: 'tx:pending',
    isCrossChain: true
  })
  await assert.rejects(
    monitor.removeAccounts(scope.walletId, [scope.accountId]),
    /quote store unavailable/
  )
  assert.deepEqual(
    values.get('rhea_swap_pending_transactions').map(item => item.quoteHandle),
    ['rhea-quote:pending']
  )
  fail = false
  await monitor.removeAccounts(scope.walletId, [scope.accountId])
  assert.deepEqual(discarded.sort(), ['rhea-quote:graph', 'rhea-quote:pending'])
  assert.deepEqual(values.get('rhea_swap_pending_transactions'), [])
})

it('removes every account of one wallet without affecting another wallet', async () => {
  const values = storage()
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const jobs = [
    ['rhea-quote:wallet-a-one', 'wallet:a', 'account:one'],
    ['rhea-quote:wallet-a-two', 'wallet:a', 'account:two'],
    ['rhea-quote:wallet-b-one', 'wallet:b', 'account:one']
  ]
  const monitor = new RheaSwapTransactionMonitor(new RheaSwapService({}, sessions))
  monitor.repository = {
    async listRheaSwapQuoteHandlesByAccountScope(accountScope) {
      return jobs
        .filter(
          ([, walletId, accountId]) =>
            walletId === accountScope.keyDomainId && accountId === accountScope.accountId
        )
        .map(([handle]) => handle)
    }
  }
  for (const [quoteHandle, walletId, accountId] of jobs) {
    await sessions.put({ schemaVersion: 1, quoteHandle })
    await monitor.add({
      quoteHandle,
      accountKey: `mainnet_${walletId}_${accountId}`,
      walletId,
      accountId,
      transactionId: `tx:${quoteHandle}`,
      isCrossChain: true
    })
  }
  await monitor.removeAccounts('wallet:a', ['account:one', 'account:two'])
  assert.equal(await sessions.get('rhea-quote:wallet-a-one'), null)
  assert.equal(await sessions.get('rhea-quote:wallet-a-two'), null)
  assert.notEqual(await sessions.get('rhea-quote:wallet-b-one'), null)
  assert.deepEqual(
    values.get('rhea_swap_pending_transactions').map(item => item.quoteHandle),
    ['rhea-quote:wallet-b-one']
  )
})

it('preserves canonical external RHEA destinations through monitor registration and restore', async () => {
  const identity = resolveRheaSwapDestinationIdentity(
    { assetId: 'nep141:tron-trx.omft.near', tokenListChainId: 195 },
    null
  )
  assert.equal(identity.chainId, 'rhea:195')
  assert.match(identity.assetId, /^rhea:195\/rhea:/)
  const values = storage()
  const tx = transaction()
  tx.quoteBinding.destinationAsset = identity.assetId
  const job = {
    quoteHandle: tx.quoteBinding.quoteHandle,
    ...scope,
    transactionId: tx.id,
    isCrossChain: true,
    destinationAsset: identity.assetId
  }
  const monitor = new RheaSwapTransactionMonitor({})
  await monitor.add(job)
  assert.equal(values.get('rhea_swap_pending_transactions')[0].destinationAsset, identity.assetId)
  const reloaded = new RheaSwapTransactionMonitor({})
  await reloaded.restorePendingZcashSwaps([])
  assert.equal(reloaded.pending.get(job.quoteHandle).destinationAsset, identity.assetId)

  storage()
  const restored = new RheaSwapTransactionMonitor(
    {
      async canRecoverTransactionSubmission() {
        return true
      }
    },
    { loadZcashTransactions: async () => [tx] }
  )
  assert.equal(await restored.restorePendingZcashSwaps([scope]), 1)
  assert.equal(restored.pending.get(job.quoteHandle).destinationAsset, identity.assetId)
})

it('retries a terminal graph report after restart and deduplicates concurrent sends', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const handle = 'rhea-quote:retry'
  await sessions.put({
    schemaVersion: 1,
    quoteHandle: handle,
    build: { executionId: 'execution:retry' },
    submission: {
      sourceHash: 'source:retry',
      orderId: 'order:retry',
      router: 'router:retry',
      statusChainId: '42161',
      reportRequest: {},
      reportStatus: 'failed'
    }
  })
  let attempts = 0
  let available = false
  const client = {
    async reportRaw() {
      attempts += 1
      await Promise.resolve()
      if (!available) throw new Error('offline')
    }
  }
  const initial = new RheaSwapService(client, sessions)
  await initial.retireReportedSubmission(handle)
  assert.equal(await initial.retryPendingReports(), true)
  assert.equal((await sessions.get(handle)).submission.disposeAfterReport, true)

  available = true
  const resumed = new RheaSwapService(client, sessions)
  await Promise.all([resumed.reportSubmission(handle), resumed.reportSubmission(handle)])
  assert.equal(attempts, 2)
  assert.equal(await sessions.get(handle), null)
  assert.equal(await resumed.retryPendingReports(), false)
})

it('keeps terminal disposal when retirement overlaps an in-flight report', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const handle = 'rhea-quote:overlap'
  await sessions.put({
    schemaVersion: 1,
    quoteHandle: handle,
    build: { executionId: 'execution:overlap' },
    submission: {
      sourceHash: 'source:overlap',
      orderId: 'order:overlap',
      router: 'router:overlap',
      statusChainId: '42161',
      reportRequest: {},
      reportStatus: 'pending'
    }
  })
  let started
  const reportStarted = new Promise(resolve => {
    started = resolve
  })
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const service = new RheaSwapService(
    {
      async reportRaw() {
        started()
        await gate
      }
    },
    sessions
  )
  const report = service.reportSubmission(handle)
  await reportStarted
  const retire = service.retireReportedSubmission(handle)
  release()
  await Promise.all([report, retire])
  assert.equal(await sessions.get(handle), null)
  assert.equal(service.sessionQueues.size, 0)
})

it('waits for an in-flight report before clearing wallet sessions', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const handle = 'rhea-quote:reset-overlap'
  await sessions.put({
    schemaVersion: 1,
    quoteHandle: handle,
    build: { executionId: 'execution:reset-overlap' },
    submission: {
      sourceHash: 'source:reset-overlap',
      orderId: 'order:reset-overlap',
      router: 'router:reset-overlap',
      statusChainId: '42161',
      reportRequest: {},
      reportStatus: 'pending'
    }
  })
  let reportStarted
  const started = new Promise(resolve => {
    reportStarted = resolve
  })
  let finishReport
  const gate = new Promise(resolve => {
    finishReport = resolve
  })
  const service = new RheaSwapService(
    {
      async reportRaw() {
        reportStarted()
        await gate
      }
    },
    sessions
  )
  const report = service.reportSubmission(handle)
  await started
  const clear = service.clearSessions()
  await assert.rejects(service.quote({}), /being cleared/)
  finishReport()
  await Promise.all([report, clear])
  assert.equal(await sessions.get(handle), null)
})

it('skips a missing quote session without inventing order completion', async () => {
  const values = storage()
  const tx = transaction()
  const monitor = new RheaSwapTransactionMonitor(
    {
      async canRecoverTransactionSubmission() {
        return false
      },
      async recordTransactionSubmission() {
        throw new Error('quote session unavailable')
      },
      async reportSubmission() {
        throw new Error('must not report')
      },
      async getOrderStatus() {
        throw new Error('must not poll')
      }
    },
    { loadZcashTransactions: async () => [tx] }
  )
  assert.equal(await monitor.restorePendingZcashSwaps([scope]), 0)
  assert.equal(tx.status, 'pending')
  assert.equal(values.has('rhea_swap_pending_transactions'), false)
})

it('does not bind a persisted quote to a different Zcash transaction', async () => {
  const values = storage()
  const tx = transaction()
  const monitor = new RheaSwapTransactionMonitor(
    {
      async canRecoverTransactionSubmission() {
        return true
      },
      async recordTransactionSubmission() {
        throw new Error('must not submit')
      },
      async discard() {}
    },
    { loadZcashTransactions: async () => [tx] }
  )
  await monitor.restorePendingZcashSwaps([scope])
  tx.quoteBinding.quoteHandle = 'rhea-quote:another'
  await monitor.check(values.get('rhea_swap_pending_transactions')[0])
  assert.equal(tx.status, 'pending')
  assert.equal(values.get('rhea_swap_pending_transactions').length, 0)
})
