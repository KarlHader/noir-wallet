import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { RheaSwapTransactionMonitor } from '../../../src/background/rhea-swap-transaction-monitor.ts'
import {
  createRheaSwapSignedBatchGraph,
  createRheaSwapSignedOrderGraph,
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import { getZcashChainId } from '../../../src/core/chains/registry/index.ts'
import { prepareRheaSwapZcashDestinationCatchUp } from '../../../src/background/rhea-swap-zcash-sync.ts'

const scope = { keyDomainId: 'wallet:near', accountId: 'account:near' }
const sourceHashes = ['1'.repeat(32), `${'1'.repeat(31)}2`]
const destinationHash = `0x${'ab'.repeat(32)}`

function graph() {
  return createRheaSwapSignedBatchGraph({
    transactionId: parseTransactionId('tx:rhea-near:monitor'),
    scope,
    binding: {
      schemaVersion: 1,
      provider: 'rhea-cross-chain-dex',
      kind: 'swap',
      quoteHandle: 'rhea-quote:monitor',
      executionId: 'execution-monitor',
      router: 'near-intents',
      sourceTarget: 'router.near',
      sender: 'alice.near',
      originAmountRaw: '1000',
      expiresAt: 5_000,
      isCrossChain: true,
      origin: {
        chainId: 'near:mainnet',
        assetId: 'near:mainnet/slip44:397',
        protocolChainId: 'near',
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
    },
    sourceHashes,
    segmentIds: {
      origins: [
        parseTransactionSegmentId('segment:rhea-near:origin:0:monitor'),
        parseTransactionSegmentId('segment:rhea-near:origin:1:monitor')
      ],
      relay: parseTransactionSegmentId('segment:rhea-near:relay:monitor'),
      destination: parseTransactionSegmentId('segment:rhea-near:destination:monitor'),
      refund: parseTransactionSegmentId('segment:rhea-near:refund:monitor')
    },
    now: 1_000
  })
}

async function broadcast(repository, current, segmentIndex, observedAt) {
  const segment = current.segments.filter(candidate => candidate.role === 'origin')[segmentIndex]
  const result = await repository.applySegmentEvent({
    scope,
    transactionId: current.root.id,
    segmentId: segment.id,
    event: {
      id: parseTransactionEventId(`event:rhea-near:broadcast:${segmentIndex}`),
      status: 'broadcast',
      cause: 'progress',
      observedAt,
      evidence: { transactionHash: sourceHashes[segmentIndex], requiredConfirmations: 1 }
    },
    expectedRootRevision: current.root.revision,
    expectedSegmentRevision: segment.revision
  })
  assert.equal(result.status, 'applied')
  return result.graph
}

test('waits for every NEAR origin before reporting the final batch hash', async () => {
  const calls = []
  const service = {
    async recordTransactionSubmission(_handle, sourceHash) {
      calls.push(`record:${sourceHash}`)
    },
    async reportSubmission() {
      calls.push('report')
    },
    async getOrderStatus() {
      calls.push('status')
      return { status: 'pending' }
    },
    async retireReportedSubmission() {
      calls.push('retire')
    }
  }
  const repository = new InMemoryTransactionRepository()
  const initial = graph()
  assert.doesNotThrow(() => assertPersistableTransactionGraph(initial))
  await repository.create(initial)
  const firstBroadcast = await broadcast(repository, initial, 0, 1_001)
  const monitor = new RheaSwapTransactionMonitor(service)
  monitor.repository = repository

  assert.equal(await monitor.checkGraph(firstBroadcast), false)
  assert.deepEqual(calls, [])

  const fullBroadcast = await broadcast(repository, firstBroadcast, 1, 1_002)
  assert.equal(await monitor.checkGraph(fullBroadcast), false)
  assert.deepEqual(calls, [`record:${sourceHashes[1]}`, 'report', 'status'])
})

test('refreshes both affected chains as soon as a RHEA order completes', async () => {
  const refreshes = []
  const notifications = []
  const service = {
    async recordTransactionSubmission() {},
    async reportSubmission() {},
    async getOrderStatus() {
      return { status: 'completed', destinationHash }
    },
    async retireReportedSubmission() {}
  }
  const repository = new InMemoryTransactionRepository()
  const initial = graph()
  await repository.create(initial)
  const firstBroadcast = await broadcast(repository, initial, 0, 1_001)
  const fullBroadcast = await broadcast(repository, firstBroadcast, 1, 1_002)
  const monitor = new RheaSwapTransactionMonitor(service, {
    refreshPortfolio: async request => refreshes.push(request),
    notifyStatus: (quoteHandle, status) => notifications.push({ quoteHandle, status })
  })
  monitor.repository = repository

  assert.equal(await monitor.checkGraph(fullBroadcast), true)
  const completed = await repository.get(scope, fullBroadcast.root.id)
  assert.equal(
    completed.segments.find(segment => segment.role === 'destination').evidence.transactionHash,
    destinationHash
  )
  assert.deepEqual(refreshes, [
    {
      scope,
      chainIds: ['near:mainnet', 'zcash:mainnet']
    }
  ])
  assert.deepEqual(notifications, [
    {
      quoteHandle: 'rhea-quote:monitor',
      status: {
        status: 'SUCCESS',
        originAsset: 'near:mainnet/slip44:397',
        destinationAsset: 'zcash:mainnet/slip44:133',
        swapDetails: {
          originChainTxHashes: sourceHashes.map(hash => ({ hash })),
          destinationChainTxHashes: [{ hash: destinationHash }]
        }
      }
    }
  ])
})

test('retains a processing destination hash when completion omits it', async () => {
  let orderStatus = 'processing'
  const notifications = []
  const service = {
    async recordTransactionSubmission() {},
    async reportSubmission() {},
    async getOrderStatus() {
      return { status: orderStatus, ...(orderStatus === 'processing' ? { destinationHash } : {}) }
    },
    async retireReportedSubmission() {
      assert.equal(orderStatus, 'completed')
    }
  }
  const repository = new InMemoryTransactionRepository()
  const initial = graph()
  await repository.create(initial)
  const firstBroadcast = await broadcast(repository, initial, 0, 1_001)
  const fullBroadcast = await broadcast(repository, firstBroadcast, 1, 1_002)
  const monitor = new RheaSwapTransactionMonitor(service, {
    notifyStatus: (_handle, status) => notifications.push(status)
  })
  monitor.repository = repository

  assert.equal(await monitor.checkGraph(fullBroadcast), false)
  const processing = await repository.get(scope, fullBroadcast.root.id)
  const destination = processing.segments.find(segment => segment.role === 'destination')
  assert.equal(destination.status, 'broadcast')
  assert.equal(destination.evidence.transactionHash, destinationHash)
  assert.notEqual(processing.root.status, 'final')

  assert.equal(await monitor.checkGraph(processing), false)
  const repeated = await repository.get(scope, fullBroadcast.root.id)
  assert.equal(
    repeated.segments.find(segment => segment.role === 'destination').revision,
    processing.segments.find(segment => segment.role === 'destination').revision
  )
  orderStatus = 'completed'
  assert.equal(await monitor.checkGraph(repeated), true)
  assert.equal(notifications.at(-1).status, 'SUCCESS')
  assert.deepEqual(notifications.at(-1).swapDetails.destinationChainTxHashes, [
    { hash: destinationHash }
  ])
})

test('still reads cross-chain completion when submission reporting fails', async () => {
  const calls = []
  const service = {
    async recordTransactionSubmission() {
      calls.push('record')
    },
    async reportSubmission() {
      calls.push('report')
      throw new Error('report unavailable')
    },
    async getOrderStatus() {
      calls.push('status')
      return { status: 'completed' }
    },
    async retireReportedSubmission() {
      calls.push('retire')
    }
  }
  const repository = new InMemoryTransactionRepository()
  const initial = graph()
  await repository.create(initial)
  const firstBroadcast = await broadcast(repository, initial, 0, 1_001)
  const fullBroadcast = await broadcast(repository, firstBroadcast, 1, 1_002)
  const monitor = new RheaSwapTransactionMonitor(service, { notifyStatus: () => {} })
  monitor.repository = repository

  assert.equal(await monitor.checkGraph(fullBroadcast), true)
  assert.deepEqual(calls, ['record', 'report', 'status', 'retire'])
})

describe('Zcash destination catch-up', () => {
  const scope = { keyDomainId: 'wallet:swap', accountId: 'account:swap' }
  const zcashChainId = getZcashChainId('mainnet')

  function signedOrder(destinationChainId = zcashChainId) {
    return createRheaSwapSignedOrderGraph({
      transactionId: parseTransactionId('tx:rhea:zcash-catch-up'),
      scope,
      binding: {
        schemaVersion: 1,
        provider: 'rhea-cross-chain-dex',
        kind: 'swap',
        quoteHandle: 'rhea-quote:zcash-catch-up',
        executionId: 'execution-zcash-catch-up',
        router: 'router.near',
        sourceTarget: 'router.near',
        sender: 'alice.near',
        originAmountRaw: '1000',
        expiresAt: 50_000,
        isCrossChain: true,
        origin: {
          chainId: 'near:mainnet',
          assetId: 'near:mainnet/slip44:397',
          protocolChainId: 'near',
          protocolAssetId: 'native'
        },
        destination: {
          chainId: destinationChainId,
          assetId:
            destinationChainId === zcashChainId
              ? `${zcashChainId}/slip44:133`
              : 'eip155:1/slip44:60',
          protocolChainId: destinationChainId === zcashChainId ? 'zcash' : '1',
          protocolAssetId: destinationChainId === zcashChainId ? 'nep141:zec.omft.near' : 'native',
          recipient:
            destinationChainId === zcashChainId
              ? 'u1destination'
              : '0x1111111111111111111111111111111111111111',
          expectedAmountRaw: '900',
          minimumAmountRaw: '850'
        }
      },
      orderId: 'order-zcash-catch-up',
      segmentIds: {
        origin: parseTransactionSegmentId('segment:rhea:origin:zcash-catch-up'),
        relay: parseTransactionSegmentId('segment:rhea:relay:zcash-catch-up'),
        destination: parseTransactionSegmentId('segment:rhea:destination:zcash-catch-up'),
        refund: parseTransactionSegmentId('segment:rhea:refund:zcash-catch-up')
      },
      now: 1_000
    })
  }

  function createMonitor(destinationChainId, prepare) {
    const repository = new InMemoryTransactionRepository()
    const graph = signedOrder(destinationChainId)
    const notifications = []
    const monitor = new RheaSwapTransactionMonitor(
      {
        async reportSubmission() {},
        async getOrderStatus() {
          return { status: 'completed', destinationHash: '0x' + 'a'.repeat(64) }
        },
        async retireReportedSubmission() {}
      },
      {
        prepareZcashDestinationCatchUp: prepare,
        notifyStatus: (_handle, status) => notifications.push(status.status)
      }
    )
    monitor.repository = repository
    return { monitor, repository, graph, notifications }
  }

  async function confirmOrigin(repository, graph) {
    const origin = graph.segments.find(segment => segment.role === 'origin')
    const result = await repository.applySegmentEvent({
      scope,
      transactionId: graph.root.id,
      segmentId: origin.id,
      event: {
        id: parseTransactionEventId('event:rhea:origin-confirmed:zcash-catch-up'),
        status: 'final',
        cause: 'progress',
        observedAt: 1_001,
        evidence: { externalReference: 'order-zcash-catch-up' }
      },
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: origin.revision
    })
    assert.equal(result.status, 'applied')
    return result.graph
  }

  it('prepares catch-up only for a completed canonical Zcash destination before terminal status', async () => {
    const calls = []
    let finishScan
    const scanFinished = new Promise(resolve => {
      finishScan = resolve
    })
    let scanSettled = false
    const active = syncDependencies({
      catchUp: async () => {
        await scanFinished
        scanSettled = true
      }
    })
    const zcash = createMonitor(zcashChainId, async destinationScope => {
      calls.push(destinationScope)
      if (calls.length === 1) throw new Error('catch-up marker unavailable')
      await prepareRheaSwapZcashDestinationCatchUp(destinationScope, active.dependencies)
    })
    await zcash.repository.create(zcash.graph)
    const readyZcash = await confirmOrigin(zcash.repository, zcash.graph)

    await assert.rejects(zcash.monitor.checkGraph(readyZcash), /catch-up marker unavailable/)
    const retryable = await zcash.repository.get(scope, zcash.graph.root.id)
    assert.equal(retryable.root.status, 'confirming')
    assert.notEqual(
      retryable.segments.find(segment => segment.role === 'destination').status,
      'final'
    )
    assert.deepEqual(zcash.notifications, [])

    await zcash.monitor.checkGraph(readyZcash)
    assert.deepEqual(calls, [scope, scope])
    assert.equal((await zcash.repository.get(scope, zcash.graph.root.id)).root.status, 'final')
    assert.deepEqual(zcash.notifications, ['SUCCESS'])
    assert.equal(scanSettled, false)
    assert.equal(active.calls.marks.length, 1)
    finishScan()
    await scanFinished

    const other = createMonitor('eip155:1', async destinationScope => calls.push(destinationScope))
    await other.repository.create(other.graph)
    await other.monitor.checkGraph(await confirmOrigin(other.repository, other.graph))
    assert.equal(calls.length, 2)
    assert.deepEqual(other.notifications, ['SUCCESS'])
  })

  it('leaves a Zcash-origin swap pending when destination catch-up cannot be marked', async () => {
    const tx = {
      id: 'tx:zcash-rhea:destination-catch-up',
      txHash: 'a'.repeat(64),
      type: 'swap',
      status: 'pending',
      quoteBinding: {
        provider: 'rhea-cross-chain-dex',
        quoteHandle: 'rhea-quote:destination-catch-up'
      }
    }
    const pending = {
      quoteHandle: tx.quoteBinding.quoteHandle,
      accountKey: 'mainnet_wallet:swap_account:swap',
      walletId: scope.keyDomainId,
      accountId: scope.accountId,
      transactionId: tx.id,
      isCrossChain: true,
      destinationAsset: `${zcashChainId}/slip44:133`
    }
    let failMarker = true
    const monitor = new RheaSwapTransactionMonitor(
      {
        async canRecoverTransactionSubmission() {
          return true
        },
        async recordTransactionSubmission() {},
        async reportSubmission() {},
        async getOrderStatus() {
          return { status: 'completed', destinationHash: 'b'.repeat(64) }
        },
        async discard() {}
      },
      {
        loadZcashTransactions: async () => [tx],
        updateZcashTransaction: async (_key, _id, updates) => Object.assign(tx, updates),
        prepareZcashDestinationCatchUp: async () => {
          if (failMarker) throw new Error('catch-up marker unavailable')
        }
      }
    )
    monitor.pending.set(pending.quoteHandle, pending)
    monitor.loaded = true
    await assert.rejects(monitor.checkPending(pending), /catch-up marker unavailable/)
    assert.equal(tx.status, 'pending')
    assert.equal(monitor.pending.has(pending.quoteHandle), true)

    const previousChrome = globalThis.chrome
    globalThis.chrome = { storage: { local: { async set() {} } } }
    try {
      failMarker = false
      await monitor.checkPending(pending)
      assert.equal(tx.status, 'success')
      assert.equal(monitor.pending.has(pending.quoteHandle), false)
    } finally {
      globalThis.chrome = previousChrome
    }
  })

  function syncDependencies(overrides = {}) {
    const calls = { marks: [], scans: [], errors: [] }
    const dependencies = {
      getNetwork: () => 'mainnet',
      accountExists: () => true,
      getActiveScope: () => ({
        network: 'mainnet',
        walletId: scope.keyDomainId,
        accountId: scope.accountId
      }),
      markNeedsCatchUp: async (walletId, accountId) => calls.marks.push([walletId, accountId]),
      catchUp: async (walletId, accountId) => calls.scans.push([walletId, accountId]),
      onCatchUpError: error => calls.errors.push(error),
      ...overrides
    }
    return { calls, dependencies }
  }

  it('persists the marker but does not wait for the active account scan', async () => {
    let finishScan
    const scanFinished = new Promise(resolve => {
      finishScan = resolve
    })
    const { calls, dependencies } = syncDependencies({
      catchUp: async (walletId, accountId) => {
        calls.scans.push([walletId, accountId])
        await scanFinished
      }
    })
    await prepareRheaSwapZcashDestinationCatchUp(scope, dependencies)
    assert.deepEqual(calls.marks, [[scope.keyDomainId, scope.accountId]])
    assert.deepEqual(calls.scans, [[scope.keyDomainId, scope.accountId]])
    finishScan()
    await scanFinished
  })

  it('defers inactive accounts and excludes changed networks or deleted accounts', async () => {
    const inactive = syncDependencies({
      getActiveScope: () => ({
        network: 'mainnet',
        walletId: scope.keyDomainId,
        accountId: 'account:other'
      })
    })
    await prepareRheaSwapZcashDestinationCatchUp(scope, inactive.dependencies)
    assert.equal(inactive.calls.marks.length, 1)
    assert.equal(inactive.calls.scans.length, 0)

    const deleted = syncDependencies({ accountExists: () => false })
    await prepareRheaSwapZcashDestinationCatchUp(scope, deleted.dependencies)
    assert.equal(deleted.calls.marks.length, 0)

    for (const overrides of [
      { getNetwork: () => 'testnet' },
      {
        getActiveScope: () => ({
          network: 'testnet',
          walletId: scope.keyDomainId,
          accountId: scope.accountId
        })
      }
    ]) {
      const changed = syncDependencies(overrides)
      await assert.rejects(
        prepareRheaSwapZcashDestinationCatchUp(scope, changed.dependencies),
        /requires Mainnet/
      )
      assert.equal(changed.calls.marks.length, 0)
    }
  })

  it('keeps the persisted marker when a later scan fails', async () => {
    const failure = new Error('scan unavailable')
    const { calls, dependencies } = syncDependencies({
      catchUp: async () => {
        throw failure
      }
    })
    await prepareRheaSwapZcashDestinationCatchUp(scope, dependencies)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.marks.length, 1)
    assert.deepEqual(calls.errors, [failure])
  })

  it('does not start a scan when the marker write fails', async () => {
    const { calls, dependencies } = syncDependencies({
      markNeedsCatchUp: async () => {
        throw new Error('storage unavailable')
      }
    })
    await assert.rejects(
      prepareRheaSwapZcashDestinationCatchUp(scope, dependencies),
      /storage unavailable/
    )
    assert.equal(calls.scans.length, 0)
  })
})
