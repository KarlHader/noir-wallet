import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseTransactionId } from '../../../../src/core/transactions/domain/index.ts'
import {
  BitcoinRpcError,
  BitcoinTransactionMonitor
} from '../../../../src/infrastructure/chains/bitcoin/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const transactionHash = 'a'.repeat(64)
const blockHash = 'b'.repeat(64)
const scope = { keyDomainId: 'key-domain:1', accountId: 'account:1' }
const secondScope = { keyDomainId: 'key-domain:2', accountId: 'account:2' }
const chainAccount = {
  id: 'chain-account:bitcoin:monitor',
  scope: { ...scope, chainId },
  derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
  identity: {
    kind: 'account-identifier',
    value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
  },
  createdAt: 1_000
}

function graph(
  transactionId = 'transaction:bitcoin:monitor',
  status = 'broadcast',
  rootScope = scope
) {
  const segmentId = `segment:${transactionId}`
  const inclusion =
    status === 'confirming' || status === 'final'
      ? {
          blockHash,
          blockHeight: 100,
          confirmations: status === 'final' ? 6 : 3,
          requiredConfirmations: 6
        }
      : {}
  return {
    root: {
      id: transactionId,
      scope: rootScope,
      kind: 'transfer',
      status,
      segmentIds: [segmentId],
      createdAt: 1_000,
      updatedAt: 1_000,
      revision: 0
    },
    segments: [
      {
        id: segmentId,
        transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId, chainAccountId: chainAccount.id },
        status,
        requiredForFinality: true,
        dependsOn: [],
        evidence: { transactionHash, ...inclusion },
        createdAt: 1_000,
        updatedAt: 1_000,
        revision: 0
      }
    ]
  }
}

function rpc(getStatus, getTip = () => 102) {
  return {
    getTransactionStatus: async () => getStatus(),
    getTipHeight: async () => getTip(),
    getOutputSpendStatus: async () => ({ spent: false })
  }
}

function committedReservation(transactionId) {
  return {
    schemaVersion: 1,
    chainAccount,
    accountIndex: 0,
    addressType: 'p2wpkh',
    transactionId,
    state: 'committed',
    outpoints: [{ transactionId: 'c'.repeat(64), outputIndex: 1 }],
    createdAt: 1_000,
    updatedAt: 1_050
  }
}

function recoveryDependencies(transactionId, { persistedUtxos, refreshedUtxos = [] } = {}) {
  const reservation = committedReservation(transactionId)
  let retired = false
  let refreshCalls = 0
  const persistedState = {
    chainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 1,
      maximumAddressesPerTarget: 2,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: 0,
          complete: false
        }
      ]
    },
    observations: [
      {
        derived: {
          chainId,
          addressType: 'p2wpkh',
          accountIndex: 0,
          change: false,
          addressIndex: 0,
          address: chainAccount.identity.value,
          addressScheme: 'bitcoin-p2wpkh',
          derivationScheme: 'bip84',
          derivationPath: "m/84'/0'/0'/0/0",
          publicKey: `0x02${'1'.repeat(64)}`
        },
        activity: { confirmedTransactionCount: 1, mempoolTransactionCount: 0, used: true },
        utxos: persistedUtxos ?? [
          {
            transactionId: reservation.outpoints[0].transactionId,
            outputIndex: reservation.outpoints[0].outputIndex,
            valueRaw: '1000',
            status: { confirmed: true, blockHeight: 90, blockHash: 'd'.repeat(64) }
          }
        ]
      }
    ],
    updatedAt: 1_000
  }
  return {
    inputReservations: {
      listByAccountScope: async () => (retired ? [] : [reservation]),
      retireCommitted: async () => {
        if (retired) return false
        retired = true
        return true
      }
    },
    discoveryRepository: {
      get: async () => persistedState,
      putRefresh: async refresh => {
        persistedState.checkpoint = refresh.checkpoint
        persistedState.observations = refresh.observations
        persistedState.updatedAt = refresh.updatedAt
      }
    },
    discoveryRefresher: {
      refresh: async ({ state, mode }) => {
        refreshCalls += 1
        expect(mode).toBe('active')
        return {
          checkpoint: state.checkpoint,
          observations: state.observations.map(observation => ({
            ...observation,
            utxos: refreshedUtxos
          }))
        }
      }
    },
    isRetired: () => retired,
    getRefreshCalls: () => refreshCalls
  }
}

function ids() {
  let value = 0
  return () => String(++value)
}

test.describe('Bitcoin persisted transaction monitor', () => {
  test('persists confirmation progress and finality without duplicate writes', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph())
    let tipHeight = 102
    let now = 1_100
    const balanceRefreshes = []
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        () => ({ confirmed: true, blockHeight: 100, blockHash }),
        () => tipHeight
      ),
      requiredConfirmations: 6,
      now: () => now,
      createEventId: ids(),
      onBalanceRefreshRequired: async input => {
        balanceRefreshes.push({
          graphStatus: input.graph.root.status,
          observationStatus: input.observation.status
        })
      }
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 1,
      unchanged: 0,
      pendingReconciliation: 0,
      errors: 0
    })
    await expect(
      repository.get(scope, parseTransactionId('transaction:bitcoin:monitor'))
    ).resolves.toMatchObject({
      root: { status: 'confirming' },
      segments: [
        {
          status: 'confirming',
          evidence: { blockHash, blockHeight: 100, confirmations: 3, requiredConfirmations: 6 }
        }
      ]
    })
    expect(balanceRefreshes).toEqual([
      { graphStatus: 'broadcast', observationStatus: 'confirming' }
    ])
    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 0, unchanged: 1 })
    expect(balanceRefreshes).toHaveLength(1)

    tipHeight = 105
    now = 1_200
    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    await expect(
      repository.get(scope, parseTransactionId('transaction:bitcoin:monitor'))
    ).resolves.toMatchObject({ root: { status: 'final' }, segments: [{ status: 'final' }] })
    expect(balanceRefreshes).toEqual([
      { graphStatus: 'broadcast', observationStatus: 'confirming' },
      { graphStatus: 'confirming', observationStatus: 'final' }
    ])
  })

  test('keeps signed and broadcast transactions unchanged while an RPC still returns not-found', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:bitcoin:signed', 'signed'))
    await repository.create(graph('transaction:bitcoin:broadcast'))
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(() => {
        throw new BitcoinRpcError('not-found', 'not found')
      }),
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 2,
      applied: 0,
      unchanged: 2,
      pendingReconciliation: 0,
      errors: 0
    })
  })

  test('does not reinterpret a missing confirmed transaction as dropped', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:bitcoin:confirming', 'confirming'))
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(() => {
        throw new BitcoinRpcError('not-found', 'not found')
      }),
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 0,
      unchanged: 0,
      pendingReconciliation: 0,
      errors: 1
    })
    await expect(
      repository.get(scope, parseTransactionId('transaction:bitcoin:confirming'))
    ).resolves.toMatchObject({
      root: { status: 'confirming' },
      segments: [{ evidence: { blockHash, confirmations: 3 } }]
    })
  })

  test('marks a missing transaction replaced only after a conflicting input spend is final', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:confirmed-conflict'
    await repository.create(graph(transactionId))
    const recovery = recoveryDependencies(transactionId)
    const replacementHash = 'e'.repeat(64)
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: {
        getTransactionStatus: async () => {
          throw new BitcoinRpcError('not-found', 'not found')
        },
        getTipHeight: async () => 105,
        getOutputSpendStatus: async () => ({
          spent: true,
          spendingTransactionId: replacementHash,
          inputIndex: 0,
          status: { confirmed: true, blockHeight: 100, blockHash: 'f'.repeat(64) }
        })
      },
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 1,
      unchanged: 0,
      pendingReconciliation: 0,
      errors: 0
    })
    await expect(repository.get(scope, parseTransactionId(transactionId))).resolves.toMatchObject({
      root: { status: 'failed', failure: { code: 'dropped' } },
      segments: [
        {
          status: 'failed',
          evidence: {
            transactionHash,
            replacementTransactionHash: replacementHash,
            externalReference: `${'c'.repeat(64)}:1`,
            blockHeight: 100,
            confirmations: 6,
            requiredConfirmations: 6
          },
          failure: { code: 'dropped' }
        }
      ]
    })
    expect(recovery.isRetired()).toBe(true)
  })

  test('keeps committed inputs when conflicting spend evidence is not final', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:unfinalized-conflict'
    await repository.create(graph(transactionId))
    const recovery = recoveryDependencies(transactionId)
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: {
        getTransactionStatus: async () => {
          throw new BitcoinRpcError('not-found', 'not found')
        },
        getTipHeight: async () => 105,
        getOutputSpendStatus: async () => ({
          spent: true,
          spendingTransactionId: 'e'.repeat(64),
          inputIndex: 0,
          status: { confirmed: true, blockHeight: 104, blockHash: 'f'.repeat(64) }
        })
      },
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 0,
      unchanged: 1,
      pendingReconciliation: 1,
      errors: 0
    })
    expect(recovery.isRetired()).toBe(false)
  })

  test('does not retire committed inputs when persisted replacement outpoint no longer matches', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:replacement-outpoint-mismatch'
    const replacementHash = 'e'.repeat(64)
    await repository.create(graph(transactionId))
    await expect(
      repository.applySegmentEvent({
        scope,
        transactionId: parseTransactionId(transactionId),
        segmentId: `segment:${transactionId}`,
        event: {
          id: 'event:bitcoin:persisted-conflict',
          status: 'failed',
          cause: 'reconciliation',
          observedAt: 1_100,
          evidence: {
            transactionHash,
            replacementTransactionHash: replacementHash,
            externalReference: `${'d'.repeat(64)}:2`,
            blockHash: 'f'.repeat(64),
            blockHeight: 100,
            confirmations: 6,
            requiredConfirmations: 6
          },
          failure: { code: 'dropped', occurredAt: 1_100 }
        },
        expectedRootRevision: 0,
        expectedSegmentRevision: 0
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const recovery = recoveryDependencies(transactionId)
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: {
        getTransactionStatus: async () => {
          throw new BitcoinRpcError('not-found', 'not found')
        },
        getTipHeight: async () => 105,
        getOutputSpendStatus: async () => ({
          spent: true,
          spendingTransactionId: replacementHash,
          inputIndex: 0,
          status: { confirmed: true, blockHeight: 100, blockHash: 'f'.repeat(64) }
        })
      },
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 0,
      applied: 0,
      unchanged: 0,
      pendingReconciliation: 1,
      errors: 0
    })
    expect(recovery.isRetired()).toBe(false)
  })

  test('recovers a committed-input cleanup interrupted after the graph became final', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:final-cleanup'
    await repository.create(graph(transactionId, 'final'))
    const recovery = recoveryDependencies(transactionId)
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        () => ({ confirmed: true, blockHeight: 100, blockHash }),
        () => 105
      ),
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 0,
      applied: 0,
      unchanged: 0,
      pendingReconciliation: 0,
      errors: 0
    })
    expect(recovery.isRetired()).toBe(true)
  })

  test('reuses a fresh persisted discovery result when it already excludes finalized inputs', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:final-already-refreshed'
    await repository.create(graph(transactionId, 'final'))
    const recovery = recoveryDependencies(transactionId, { persistedUtxos: [] })
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        () => ({ confirmed: true, blockHeight: 100, blockHash }),
        () => 105
      ),
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 0,
      applied: 0,
      unchanged: 0,
      pendingReconciliation: 0,
      errors: 0
    })
    expect(recovery.getRefreshCalls()).toBe(0)
    expect(recovery.isRetired()).toBe(true)
  })

  test('keeps polling instead of retiring while refreshed discovery still reports an input UTXO', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:final-still-unspent'
    await repository.create(graph(transactionId, 'final'))
    const recovery = recoveryDependencies(transactionId, {
      refreshedUtxos: [
        {
          transactionId: 'c'.repeat(64),
          outputIndex: 1,
          valueRaw: '1000',
          status: { confirmed: true, blockHeight: 90, blockHash: 'd'.repeat(64) }
        }
      ]
    })
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        () => ({ confirmed: true, blockHeight: 100, blockHash }),
        () => 105
      ),
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 0,
      applied: 0,
      unchanged: 0,
      pendingReconciliation: 1,
      errors: 0
    })
    expect(recovery.isRetired()).toBe(false)
  })

  test('does not trust persisted finality when a fresh chain observation has different block evidence', async () => {
    const repository = new InMemoryTransactionRepository()
    const transactionId = 'transaction:bitcoin:stale-final-evidence'
    await repository.create(graph(transactionId, 'final'))
    const recovery = recoveryDependencies(transactionId)
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        () => ({ confirmed: true, blockHeight: 100, blockHash: 'f'.repeat(64) }),
        () => 105
      ),
      inputReservations: recovery.inputReservations,
      discoveryRepository: recovery.discoveryRepository,
      discoveryRefresher: recovery.discoveryRefresher,
      requiredConfirmations: 6,
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({
      checked: 0,
      pendingReconciliation: 1,
      errors: 0
    })
    expect(recovery.isRetired()).toBe(false)
  })

  test('deduplicates equal concurrent polls without merging different Account scopes', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:bitcoin:one'))
    await repository.create(graph('transaction:bitcoin:two', 'broadcast', secondScope))
    let calls = 0
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(() => {
        calls += 1
        return { confirmed: false }
      }),
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    const [first, duplicate] = await Promise.all([monitor.poll([scope]), monitor.poll([scope])])
    expect(first).toEqual(duplicate)
    expect(first).toEqual({
      checked: 1,
      applied: 1,
      unchanged: 0,
      pendingReconciliation: 0,
      errors: 0
    })
    expect(calls).toBe(1)

    const [firstScope, otherScope] = await Promise.all([
      monitor.poll([scope]),
      monitor.poll([secondScope])
    ])
    expect(firstScope).toMatchObject({ checked: 1, errors: 0 })
    expect(otherScope).toMatchObject({ checked: 1, errors: 0 })
    expect(calls).toBe(3)
  })

  test('retries one compare-and-swap conflict against the latest graph', async () => {
    const base = new InMemoryTransactionRepository()
    await base.create(graph())
    let injected = false
    const repository = {
      create: value => base.create(value),
      get: (...args) => base.get(...args),
      list: query => base.list(query),
      hasAppliedEvent: (...args) => base.hasAppliedEvent(...args),
      deleteByAccountScope: value => base.deleteByAccountScope(value),
      applySegmentEvent: async input => {
        if (!injected) {
          injected = true
          await base.applySegmentEvent({
            ...input,
            event: {
              ...input.event,
              id: 'event:external',
              status: 'broadcast',
              observedAt: 1_050
            }
          })
          return { status: 'revision-conflict', graph: await base.get(scope, input.transactionId) }
        }
        return base.applySegmentEvent(input)
      }
    }
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(() => ({ confirmed: true, blockHeight: 100, blockHash })),
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    await expect(
      base.get(scope, parseTransactionId('transaction:bitcoin:monitor'))
    ).resolves.toMatchObject({ root: { status: 'confirming' } })
  })

  test('does not let a stale concurrent observation reopen a finalized transaction', async () => {
    const base = new InMemoryTransactionRepository()
    await base.create(graph())
    let injected = false
    const repository = {
      create: value => base.create(value),
      get: (...args) => base.get(...args),
      list: query => base.list(query),
      hasAppliedEvent: (...args) => base.hasAppliedEvent(...args),
      deleteByAccountScope: value => base.deleteByAccountScope(value),
      applySegmentEvent: async input => {
        if (!injected) {
          injected = true
          await base.applySegmentEvent({
            ...input,
            event: {
              id: 'event:external-final',
              status: 'final',
              cause: 'progress',
              observedAt: 1_200,
              evidence: {
                transactionHash,
                blockHash,
                blockHeight: 100,
                confirmations: 6,
                requiredConfirmations: 6
              }
            }
          })
          return { status: 'revision-conflict', graph: await base.get(scope, input.transactionId) }
        }
        return base.applySegmentEvent(input)
      }
    }
    const monitor = new BitcoinTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(() => ({ confirmed: true, blockHeight: 100, blockHash })),
      requiredConfirmations: 6,
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 0,
      unchanged: 1,
      pendingReconciliation: 0,
      errors: 0
    })
    await expect(
      base.get(scope, parseTransactionId('transaction:bitcoin:monitor'))
    ).resolves.toMatchObject({
      root: { status: 'final', updatedAt: 1_200 },
      segments: [{ status: 'final', updatedAt: 1_200 }]
    })
  })

  test('rejects unsupported networks and implicit or unsafe finality policies', () => {
    const repository = new InMemoryTransactionRepository()
    const options = {
      repository,
      rpc: rpc(() => ({ confirmed: false })),
      requiredConfirmations: 6
    }
    expect(() => new BitcoinTransactionMonitor({ ...options, chainId: 'eip155:1' })).toThrow(
      /supported Bitcoin chain/
    )
    expect(
      () =>
        new BitcoinTransactionMonitor({
          ...options,
          chainId,
          requiredConfirmations: 0
        })
    ).toThrow(/finality confirmation/)
  })
})
