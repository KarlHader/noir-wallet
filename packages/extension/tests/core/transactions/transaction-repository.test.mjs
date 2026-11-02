import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import {
  IndexedDbTransactionRepository,
  InMemoryTransactionRepository,
  TRANSACTION_REPOSITORY_LIMITS
} from '../../../src/infrastructure/persistence/repositories/index.ts'
import {
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'

const zcashChainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const ethereumChainId = 'eip155:1'

function scope(accountId = 'account:1') {
  return {
    keyDomainId: 'key-domain:1',
    accountId
  }
}

function graph(
  transactionIdValue,
  accountId = 'account:1',
  chainId = zcashChainId,
  overrides = {}
) {
  const segmentId = `segment:${transactionIdValue}`
  return {
    root: {
      id: transactionIdValue,
      scope: scope(accountId),
      kind: 'transfer',
      status: 'created',
      segmentIds: [segmentId],
      createdAt: 1_000,
      updatedAt: 1_000,
      revision: 0,
      ...overrides.root
    },
    segments: [
      {
        id: segmentId,
        transactionId: transactionIdValue,
        role: 'origin',
        target: {
          kind: 'onchain',
          chainId,
          chainAccountId: `chain-account:${accountId}:${chainId}`
        },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [],
        createdAt: 1_000,
        updatedAt: 1_000,
        revision: 0,
        ...overrides.segment
      }
    ]
  }
}

function mutation(
  transactionId,
  event,
  revisions = { root: 0, segment: 0 },
  accountId = 'account:1'
) {
  return {
    scope: scope(accountId),
    transactionId: parseTransactionId(transactionId),
    segmentId: parseTransactionSegmentId(`segment:${transactionId}`),
    event,
    expectedRootRevision: revisions.root,
    expectedSegmentRevision: revisions.segment
  }
}

function event(id, status, observedAt, overrides = {}) {
  return {
    id: parseTransactionEventId(id),
    status,
    cause: 'progress',
    observedAt,
    ...overrides
  }
}

test.describe('Transaction repository', () => {
  test('rejects unbroadcast transaction graphs at the persistence boundary', async () => {
    const repository = new IndexedDbTransactionRepository()

    await expect(repository.create(graph('transaction:unbroadcast'))).rejects.toThrow(
      /signed transaction graph/
    )
    await expect(
      repository.create(
        graph('transaction:cancelled', 'account:1', zcashChainId, {
          root: {
            status: 'failed',
            failure: { code: 'user-rejected', occurredAt: 1_000 }
          },
          segment: {
            status: 'failed',
            failure: { code: 'user-rejected', occurredAt: 1_000 }
          }
        })
      )
    ).rejects.toThrow(/signed origin transaction evidence/)
  })

  test('creates idempotently without overwriting an ID conflict', async () => {
    const repository = new InMemoryTransactionRepository()
    const first = graph('transaction:1')

    await expect(repository.create(first)).resolves.toMatchObject({
      status: 'created'
    })
    await expect(repository.create(first)).resolves.toMatchObject({
      status: 'already-exists'
    })
    await expect(
      repository.create(
        graph('transaction:1', 'account:1', zcashChainId, {
          root: { kind: 'receive' }
        })
      )
    ).resolves.toMatchObject({
      status: 'id-conflict',
      graph: { root: { kind: 'transfer' } }
    })
  })

  test('requires Account scope and uses chain/status indexes', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:zec'))
    await repository.create(graph('transaction:eth', 'account:1', ethereumChainId))
    await repository.create(graph('transaction:other', 'account:2', ethereumChainId))

    await expect(
      repository.get(scope('account:2'), parseTransactionId('transaction:zec'))
    ).resolves.toBeNull()
    await expect(
      repository.list({
        scope: scope(),
        chainId: ethereumChainId
      })
    ).resolves.toMatchObject([{ root: { id: 'transaction:eth' } }])
    await expect(
      repository.list({
        scope: scope(),
        chainId: 'eip155:8453'
      })
    ).resolves.toEqual([])
    await expect(
      repository.list({
        scope: scope(),
        statuses: ['final']
      })
    ).resolves.toEqual([])
  })

  test('applies an event atomically and deduplicates its full history', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:1'))
    const broadcast = event('event:broadcast', 'broadcast', 1_100, {
      evidence: { transactionHash: 'zcash-hash' }
    })

    const applied = await repository.applySegmentEvent(mutation('transaction:1', broadcast))
    expect(applied).toMatchObject({
      status: 'applied',
      graph: {
        root: { status: 'broadcast', revision: 1 },
        segments: [{ status: 'broadcast', revision: 1 }]
      }
    })
    await expect(
      repository.applySegmentEvent(mutation('transaction:1', broadcast))
    ).resolves.toMatchObject({ status: 'duplicate-event' })
    await expect(
      repository.applySegmentEvent(
        mutation('transaction:1', event('event:broadcast', 'confirming', 1_200))
      )
    ).resolves.toMatchObject({ status: 'event-conflict' })
    await expect(
      repository.hasAppliedEvent(
        scope(),
        parseTransactionId('transaction:1'),
        parseTransactionEventId('event:broadcast')
      )
    ).resolves.toBe(true)
  })

  test('uses root and segment revisions as one compare-and-swap boundary', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(graph('transaction:1'))
    await repository.applySegmentEvent(
      mutation('transaction:1', event('event:broadcast', 'broadcast', 1_100))
    )

    const confirming = event('event:confirming', 'confirming', 1_200)
    await expect(
      repository.applySegmentEvent(mutation('transaction:1', confirming))
    ).resolves.toMatchObject({
      status: 'revision-conflict',
      graph: {
        root: { status: 'broadcast' },
        segments: [{ status: 'broadcast' }]
      }
    })
    await expect(
      repository.applySegmentEvent(mutation('transaction:1', confirming, { root: 1, segment: 1 }))
    ).resolves.toMatchObject({
      status: 'applied',
      graph: {
        root: { status: 'confirming', revision: 2 },
        segments: [{ status: 'confirming', revision: 2 }]
      }
    })
  })

  test('records stale observations once without downgrading state', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(
      graph('transaction:1', 'account:1', zcashChainId, {
        root: {
          status: 'confirming',
          updatedAt: 1_200,
          revision: 2
        },
        segment: {
          status: 'confirming',
          updatedAt: 1_200,
          revision: 2,
          evidence: {
            transactionHash: 'zcash-hash',
            confirmations: 2,
            requiredConfirmations: 10
          }
        }
      })
    )
    const stale = event('event:stale', 'broadcast', 1_100, {
      cause: 'reorg',
      evidence: { confirmations: 0 }
    })

    await expect(
      repository.applySegmentEvent(mutation('transaction:1', stale, { root: 2, segment: 2 }))
    ).resolves.toMatchObject({
      status: 'ignored-stale',
      graph: {
        root: { status: 'confirming', revision: 2 },
        segments: [{ status: 'confirming', revision: 2 }]
      }
    })
    await expect(
      repository.applySegmentEvent(mutation('transaction:1', stale, { root: 2, segment: 2 }))
    ).resolves.toMatchObject({ status: 'duplicate-event' })
  })

  test('persists reconfirming across a reorg until fresh finality', async () => {
    const repository = new InMemoryTransactionRepository()
    await repository.create(
      graph('transaction:reorg', 'account:1', zcashChainId, {
        root: { status: 'confirming', updatedAt: 1_200, revision: 2 },
        segment: {
          status: 'confirming',
          updatedAt: 1_200,
          revision: 2,
          evidence: {
            transactionHash: 'zcash-hash',
            confirmations: 2,
            requiredConfirmations: 3
          }
        }
      })
    )

    await expect(
      repository.applySegmentEvent(
        mutation(
          'transaction:reorg',
          event('event:reorg', 'broadcast', 1_300, {
            cause: 'reorg',
            evidence: { confirmations: 0 }
          }),
          { root: 2, segment: 2 }
        )
      )
    ).resolves.toMatchObject({
      status: 'applied',
      graph: {
        root: { status: 'broadcast', reconfirming: true },
        segments: [{ status: 'broadcast', reconfirming: true }]
      }
    })

    await expect(
      repository.applySegmentEvent(
        mutation(
          'transaction:reorg',
          event('event:reconfirming', 'confirming', 1_400, {
            evidence: { confirmations: 1 }
          }),
          { root: 3, segment: 3 }
        )
      )
    ).resolves.toMatchObject({
      status: 'applied',
      graph: {
        root: { status: 'confirming', reconfirming: true },
        segments: [{ status: 'confirming', reconfirming: true }]
      }
    })

    const finalized = await repository.applySegmentEvent(
      mutation(
        'transaction:reorg',
        event('event:refinalized', 'final', 1_500, {
          evidence: { confirmations: 3 }
        }),
        { root: 4, segment: 4 }
      )
    )
    expect(finalized.status).toBe('applied')
    expect(finalized.graph.root.reconfirming).toBeUndefined()
    expect(finalized.graph.segments[0].reconfirming).toBeUndefined()
  })

  test('validates records, query limits, and removes one Account partition', async () => {
    const repository = new InMemoryTransactionRepository()
    await expect(
      repository.create({
        ...graph('transaction:unsafe'),
        seedPhrase: 'must never enter transaction records'
      })
    ).rejects.toThrow(/transaction graph/)
    await repository.create(graph('transaction:one'))
    await repository.create(graph('transaction:two', 'account:2'))
    await expect(
      repository.list({
        scope: scope(),
        limit: TRANSACTION_REPOSITORY_LIMITS.list + 1
      })
    ).rejects.toThrow(/out of range/)

    await expect(repository.deleteByAccountScope(scope())).resolves.toBe(1)
    await expect(repository.list({ scope: scope() })).resolves.toEqual([])
    await expect(repository.list({ scope: scope('account:2') })).resolves.toHaveLength(1)
  })

  test('keeps repository ports independent from browser and V1 stores', () => {
    const sourceCode = [
      '../../../src/ports/repositories/transaction-repository.ts',
      '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
    ]
      .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')

    expect(sourceCode).not.toMatch(
      /chrome\.|zustand|account-data-store|indexed-db|zcash-wallet-runtime|wasm/i
    )
  })
})
