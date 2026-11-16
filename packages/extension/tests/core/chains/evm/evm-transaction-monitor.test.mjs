import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import { EvmTransactionMonitor } from '../../../../src/infrastructure/chains/evm/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'

const chainId = 'eip155:1'
const transactionHash = `0x${'a'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`
const reorgBlockHash = `0x${'c'.repeat(64)}`
const replacementTransactionHash = `0x${'d'.repeat(64)}`
const sender = `0x${'1'.repeat(40)}`
const counterparty = `0x${'2'.repeat(40)}`
const token = `0x${'3'.repeat(40)}`
const receivedToken = `0x${'4'.repeat(40)}`
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const addressTopic = address => `0x${address.slice(2).padStart(64, '0')}`
const transferLog = (address, from, to, amount, extraTopics = []) => ({
  address,
  topics: [transferTopic, addressTopic(from), addressTopic(to), ...extraTopics],
  data: `0x${amount.toString(16).padStart(64, '0')}`
})
const scope = { keyDomainId: 'key-domain:1', accountId: 'account:1' }
const secondScope = { keyDomainId: 'key-domain:2', accountId: 'account:2' }

function graph(
  transactionId = 'transaction:evm:monitor',
  status = 'broadcast',
  rootScope = scope,
  evidence = { transactionHash }
) {
  const segmentId = `segment:${transactionId}`
  return {
    root: {
      id: transactionId,
      scope: rootScope,
      kind: 'transfer',
      status,
      segmentIds: [segmentId],
      createdAt: 1_000,
      updatedAt: 1_000,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        sender: { chainId, address: sender }
      }
    },
    segments: [
      {
        id: segmentId,
        transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status,
        requiredForFinality: true,
        dependsOn: [],
        evidence,
        createdAt: 1_000,
        updatedAt: 1_000,
        revision: 0
      }
    ]
  }
}

function rpc(
  receipt,
  finalizedBlock = '100',
  onReceipt = () => {},
  transactionLocation = { status: 'pending' }
) {
  return {
    broadcastRawTransaction: async () => transactionHash,
    hasTransaction: async () => true,
    getTransactionLocation: async () => transactionLocation,
    getTransactionReceipt: async () => {
      onReceipt()
      return receipt
    },
    getFinalizedBlockNumber: async () => finalizedBlock
  }
}

function receipt(status = 'success', blockNumber = '101') {
  return { transactionHash, blockHash, blockNumber, status }
}

function ids() {
  let value = 0
  return () => String(++value)
}

test.describe('EVM persisted transaction monitor', () => {
  test('persists a successful receipt as final without duplicate poll writes', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph())
    let now = 1_100
    const activeReceipt = receipt()
    const createEventId = ids()
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(activeReceipt, '100'),
      now: () => now,
      createEventId
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 1,
      unchanged: 0,
      errors: 0
    })
    const finalized = await repository.get(scope, parseTransactionId('transaction:evm:monitor'))
    expect(finalized.root.status).toBe('final')
    expect(finalized.segments[0].evidence).toMatchObject({ blockHash, blockHeight: 101 })
    expect(finalized.segments[0].evidence.assetEffects).toBeUndefined()

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 0,
      applied: 0,
      unchanged: 0,
      errors: 0
    })
  })

  test('persists net receipt token movements and known native value with final evidence', async () => {
    const repository = new InMemoryTransactionRepository()
    const contractCall = graph('transaction:evm:receipt-effects')
    contractCall.root.kind = 'contract-call'
    contractCall.root.intent.direction = 'contract'
    contractCall.root.intent.recipient = { chainId, address: counterparty }
    contractCall.root.intent.primaryAmount = {
      assetId: `${chainId}/slip44:60`,
      amountRaw: '12'
    }
    await repository.create(contractCall)
    const activeReceipt = {
      ...receipt(),
      logs: [
        transferLog(token, sender, counterparty, 100n),
        transferLog(token, counterparty, sender, 30n),
        transferLog(receivedToken, counterparty, sender, 50n),
        transferLog(token, sender, sender, 10n),
        transferLog(token, sender, counterparty, 1n, [`0x${'0'.repeat(64)}`])
      ]
    }
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(activeReceipt),
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    const finalized = await repository.get(scope, parseTransactionId(contractCall.root.id))
    expect(finalized.segments[0].evidence.assetEffects).toEqual({
      source: 'receipt',
      completeness: 'partial',
      changes: [
        { assetId: `${chainId}/slip44:60`, direction: 'outgoing', amountRaw: '12' },
        { assetId: `${chainId}/erc20:${token}`, direction: 'outgoing', amountRaw: '70' },
        { assetId: `${chainId}/erc20:${receivedToken}`, direction: 'incoming', amountRaw: '50' }
      ]
    })
  })

  test('finalizes a successful receipt even when aggregated effects exceed the amount limit', async () => {
    const repository = new InMemoryTransactionRepository()
    const transaction = graph('transaction:evm:overflow-effects')
    await repository.create(transaction)
    const hugeAmount = (1n << 256n) - 1n
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc({
        ...receipt(),
        logs: Array.from({ length: 9 }, () => transferLog(token, counterparty, sender, hugeAmount))
      }),
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    const finalized = await repository.get(scope, parseTransactionId(transaction.root.id))
    expect(finalized.root.status).toBe('final')
    expect(finalized.segments[0].evidence.assetEffects).toBeUndefined()
  })

  test('marks the original transaction cancelled after its local replacement finalizes', async () => {
    const repository = new InMemoryTransactionRepository()
    const original = graph('transaction:evm:original-cancelled')
    const cancellation = graph('transaction:evm:cancellation', 'broadcast', scope, {
      transactionHash: replacementTransactionHash,
      externalReference: 'evm-nonce:7'
    })
    cancellation.root.kind = 'cancel'
    cancellation.root.relation = {
      kind: 'replacement-of',
      transactionId: original.root.id
    }
    cancellation.root.intent.direction = 'self'
    await repository.create(original)
    await repository.create(cancellation)
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: {
        ...rpc(null),
        getTransactionReceipt: async hash =>
          hash === replacementTransactionHash
            ? {
                transactionHash: replacementTransactionHash,
                blockHash,
                blockNumber: '101',
                status: 'success'
              }
            : null
      },
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    await expect(
      repository.get(scope, parseTransactionId(original.root.id))
    ).resolves.toMatchObject({
      root: { status: 'failed', failure: { code: 'cancelled' } },
      segments: [
        {
          evidence: { transactionHash, replacementTransactionHash },
          failure: { code: 'cancelled' }
        }
      ]
    })
  })

  test('settles a replaced Swap origin only after the cancellation receipt succeeds', async () => {
    const repository = new InMemoryTransactionRepository()
    const swap = graph('transaction:evm:swap-origin')
    swap.root.kind = 'swap'
    swap.root.intent.evm = {
      schemaVersion: 1,
      nonce: '9',
      maxFeePerGasWei: '5000000000',
      maxPriorityFeePerGasWei: '1000000000',
      gasLimit: '21000'
    }
    const cancellation = graph('transaction:evm:swap-cancellation', 'broadcast', scope, {
      transactionHash: replacementTransactionHash,
      externalReference: 'evm-nonce:9'
    })
    cancellation.root.kind = 'cancel'
    cancellation.root.relation = { kind: 'replacement-of', transactionId: swap.root.id }
    cancellation.root.intent.direction = 'self'
    await repository.create(swap)
    await repository.create(cancellation)
    let confirmed = false
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: {
        ...rpc(null),
        getTransactionReceipt: async hash =>
          confirmed && hash === replacementTransactionHash
            ? { transactionHash: hash, blockHash, blockNumber: '101', status: 'success' }
            : null,
        getTransactionLocation: async hash =>
          hash === replacementTransactionHash ? { status: 'pending' } : { status: 'unknown' }
      },
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ errors: 0 })
    await expect(repository.get(scope, parseTransactionId(swap.root.id))).resolves.toMatchObject({
      root: { status: 'broadcast' }
    })
    confirmed = true
    await expect(monitor.poll([scope])).resolves.toMatchObject({ errors: 0 })
    await expect(repository.get(scope, parseTransactionId(swap.root.id))).resolves.toMatchObject({
      root: { kind: 'swap', status: 'failed', failure: { code: 'cancelled' } }
    })
  })

  test('recovers an ambiguously broadcast signed transaction only after the RPC knows its hash', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:signed', 'signed'))
    let known = false
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: {
        ...rpc(null),
        hasTransaction: async () => known
      },
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 0,
      unchanged: 1,
      errors: 0
    })
    known = true
    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    await expect(
      repository.get(scope, parseTransactionId('transaction:signed'))
    ).resolves.toMatchObject({ root: { status: 'broadcast' }, segments: [{ status: 'broadcast' }] })
  })

  test('marks an unknown hash as dropped only after a same-nonce replacement is finalized', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(
      graph('transaction:replaced', 'signed', scope, {
        transactionHash,
        externalReference: 'evm-nonce:7'
      })
    )
    const replacementLookups = []
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: {
        ...rpc(null, '105'),
        hasTransaction: async () => false
      },
      replacementSource: {
        findConfirmedReplacement: async input => {
          replacementLookups.push(input)
          return {
            transactionHash: replacementTransactionHash,
            blockHash: reorgBlockHash,
            blockHeight: 105,
            confirmedAt: 1_090
          }
        }
      },
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 1,
      unchanged: 0,
      errors: 0
    })
    expect(replacementLookups).toEqual([
      { sender, nonce: '7', excludedTransactionHash: transactionHash }
    ])
    await expect(
      repository.get(scope, parseTransactionId('transaction:replaced'))
    ).resolves.toMatchObject({
      root: { status: 'failed', failure: { code: 'dropped' } },
      segments: [
        {
          status: 'failed',
          evidence: {
            transactionHash,
            externalReference: 'evm-nonce:7',
            replacementTransactionHash
          },
          failure: { code: 'dropped' }
        }
      ]
    })
  })

  test('keeps an original transaction open until its replacement reaches finalized height', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(
      graph('transaction:replacement-not-final', 'broadcast', scope, {
        transactionHash,
        externalReference: 'evm-nonce:8'
      })
    )
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(null, '104', () => {}, { status: 'unknown' }),
      replacementSource: {
        findConfirmedReplacement: async () => ({
          transactionHash: replacementTransactionHash,
          blockHash: reorgBlockHash,
          blockHeight: 105,
          confirmedAt: 1_090
        })
      },
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 0,
      unchanged: 1,
      errors: 0
    })
    await expect(
      repository.get(scope, parseTransactionId('transaction:replacement-not-final'))
    ).resolves.toMatchObject({ root: { status: 'broadcast' } })
  })

  test('does not query replacement history for legacy records without persisted nonce binding', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:no-nonce', 'signed'))
    let replacementLookups = 0
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: { ...rpc(null), hasTransaction: async () => false },
      replacementSource: {
        findConfirmedReplacement: async () => {
          replacementLookups += 1
          return null
        }
      },
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ unchanged: 1, errors: 0 })
    expect(replacementLookups).toBe(0)
  })

  test('deduplicates concurrent polls and isolates transient RPC failures', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:one'))
    await repository.create(graph('transaction:two'))
    let calls = 0
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(null, '100', () => {
        calls += 1
        if (calls === 2) throw new Error('temporary network failure')
      }),
      now: () => 1_100,
      createEventId: ids(),
      concurrency: 2
    })

    const [first, second] = await Promise.all([monitor.poll([scope]), monitor.poll([scope])])
    expect(first).toEqual(second)
    expect(first).toEqual({ checked: 2, applied: 0, unchanged: 1, errors: 1 })
    expect(calls).toBe(2)
  })

  test('does not merge concurrent polls for different Account scopes', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:one'))
    await repository.create(graph('transaction:two', 'broadcast', secondScope))
    let calls = 0
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(null, '100', () => {
        calls += 1
      }),
      now: () => 1_100,
      createEventId: ids()
    })

    const [first, second] = await Promise.all([monitor.poll([scope]), monitor.poll([secondScope])])
    expect(first).toEqual({ checked: 1, applied: 0, unchanged: 1, errors: 0 })
    expect(second).toEqual({ checked: 1, applied: 0, unchanged: 1, errors: 0 })
    expect(calls).toBe(2)
  })

  test('retries one CAS conflict against the latest graph', async () => {
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
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(receipt()),
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    const persisted = await base.get(scope, parseTransactionId('transaction:evm:monitor'))
    expect(persisted.segments[0].id).toBe(
      parseTransactionSegmentId('segment:transaction:evm:monitor')
    )
    expect(persisted.root.status).toBe('final')
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
                blockHeight: 101
              }
            }
          })
          return { status: 'revision-conflict', graph: await base.get(scope, input.transactionId) }
        }
        return base.applySegmentEvent(input)
      }
    }
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(receipt(), '100'),
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 0,
      unchanged: 1,
      errors: 0
    })
    await expect(
      base.get(scope, parseTransactionId('transaction:evm:monitor'))
    ).resolves.toMatchObject({
      root: { status: 'final', updatedAt: 1_200 },
      segments: [{ status: 'final', updatedAt: 1_200 }]
    })
  })

  test('keeps finalized reverted receipts as terminal failures', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph())
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(receipt('failed', '100')),
      now: () => 1_100,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    await expect(
      repository.get(scope, parseTransactionId('transaction:evm:monitor'))
    ).resolves.toMatchObject({
      root: { status: 'failed' },
      segments: [{ status: 'failed', failure: { code: 'reverted' } }]
    })
  })

  test('persists a disappearing pre-finality receipt as a reorg and clears its inclusion', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(
      graph('transaction:reorg-disappeared', 'confirming', scope, {
        transactionHash,
        blockHash,
        blockHeight: 101
      })
    )
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(null),
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(monitor.poll([scope])).resolves.toEqual({
      checked: 1,
      applied: 1,
      unchanged: 0,
      errors: 0
    })
    await expect(
      repository.get(scope, parseTransactionId('transaction:reorg-disappeared'))
    ).resolves.toMatchObject({
      root: { status: 'broadcast' },
      segments: [
        {
          status: 'broadcast',
          evidence: { transactionHash, confirmations: 0 }
        }
      ]
    })
  })

  test('does not infer reorg from an unknown or inconsistently included transaction', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(
      graph('transaction:ambiguous-receipt', 'confirming', scope, {
        transactionHash,
        blockHash,
        blockHeight: 101
      })
    )
    const unknownMonitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(null, '100', () => {}, { status: 'unknown' }),
      now: () => 1_200,
      createEventId: ids()
    })

    await expect(unknownMonitor.poll([scope])).resolves.toMatchObject({
      applied: 0,
      unchanged: 1,
      errors: 0
    })

    const includedMonitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(null, '100', () => {}, {
        status: 'included',
        blockHash,
        blockNumber: '101'
      }),
      now: () => 1_300,
      createEventId: ids()
    })
    await expect(includedMonitor.poll([scope])).resolves.toMatchObject({
      applied: 0,
      unchanged: 1,
      errors: 0
    })
    await expect(
      repository.get(scope, parseTransactionId('transaction:ambiguous-receipt'))
    ).resolves.toMatchObject({
      root: { status: 'confirming' },
      segments: [{ status: 'confirming' }]
    })
  })

  test('persists changed inclusion as reorg evidence before finalizing it', async () => {
    const base = new InMemoryTransactionRepository()
    await base.create(
      graph('transaction:reorg-inclusion', 'confirming', scope, {
        transactionHash,
        blockHash,
        blockHeight: 101
      })
    )
    const appliedEvents = []
    const repository = {
      create: value => base.create(value),
      get: (...args) => base.get(...args),
      list: query => base.list(query),
      hasAppliedEvent: (...args) => base.hasAppliedEvent(...args),
      deleteByAccountScope: value => base.deleteByAccountScope(value),
      applySegmentEvent: input => {
        appliedEvents.push(input.event)
        return base.applySegmentEvent(input)
      }
    }
    const createEventId = ids()
    const monitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        {
          transactionHash,
          blockHash: reorgBlockHash,
          blockNumber: '102',
          status: 'success'
        },
        '100'
      ),
      now: () => 1_200,
      createEventId
    })

    await expect(monitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    expect(appliedEvents).toHaveLength(1)
    expect(appliedEvents[0]).toMatchObject({
      status: 'confirming',
      cause: 'reorg',
      evidence: { blockHash: reorgBlockHash, blockHeight: 102 }
    })

    const finalMonitor = new EvmTransactionMonitor({
      repository,
      chainId,
      rpc: rpc(
        {
          transactionHash,
          blockHash: reorgBlockHash,
          blockNumber: '102',
          status: 'success'
        },
        '102'
      ),
      now: () => 1_300,
      createEventId
    })
    await expect(finalMonitor.poll([scope])).resolves.toMatchObject({ applied: 1, errors: 0 })
    await expect(
      base.get(scope, parseTransactionId('transaction:reorg-inclusion'))
    ).resolves.toMatchObject({ root: { status: 'final' }, segments: [{ status: 'final' }] })
  })
})
