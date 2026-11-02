import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  applyTransactionSegmentEvent,
  bindNearIntentsTransactionGraph,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  reconcileTransactionRoot
} from '../../../../src/core/transactions/domain/index.ts'
import { NearIntentsTransactionMonitor } from '../../../../src/infrastructure/transactions/index.ts'

const EVM_CHAIN_ID = 'eip155:1'
const ZCASH_CHAIN_ID = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const EVM_ASSET_ID = `${EVM_CHAIN_ID}/slip44:60`
const ZEC_ASSET_ID = `${ZCASH_CHAIN_ID}/slip44:133`
const scope = { keyDomainId: 'wallet:one', accountId: 'account:one' }

function protocolGraph(kind = 'swap') {
  const transactionId = parseTransactionId('transaction:evm:protocol')
  const originId = parseTransactionSegmentId('segment:evm:protocol')
  const source = parseTransactionGraph({
    root: {
      id: transactionId,
      scope,
      kind: 'transfer',
      status: 'prepared',
      segmentIds: [originId],
      createdAt: 100,
      updatedAt: 100,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId: EVM_ASSET_ID, amountRaw: '1000' },
        sender: { chainId: EVM_CHAIN_ID, address: '0x1111111111111111111111111111111111111111' },
        recipient: {
          chainId: EVM_CHAIN_ID,
          address: '0x2222222222222222222222222222222222222222'
        }
      }
    },
    segments: [
      {
        id: originId,
        transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId: EVM_CHAIN_ID },
        status: 'prepared',
        requiredForFinality: true,
        dependsOn: [],
        createdAt: 100,
        updatedAt: 100,
        revision: 0
      }
    ]
  })
  const bound = bindNearIntentsTransactionGraph({
    graph: source,
    binding: {
      schemaVersion: 1,
      provider: 'near-intents',
      kind,
      depositAddress: '0x2222222222222222222222222222222222222222',
      refundAddress: '0x1111111111111111111111111111111111111111',
      expiresAt: 10_000,
      origin: {
        chainId: EVM_CHAIN_ID,
        assetId: EVM_ASSET_ID,
        protocolAssetId: 'nep141:eth.omft.near'
      },
      destination: {
        chainId: ZCASH_CHAIN_ID,
        assetId: ZEC_ASSET_ID,
        protocolAssetId: 'nep141:zec.omft.near',
        recipient: 'u1destination',
        expectedAmountRaw: '900',
        minimumAmountRaw: '850'
      }
    },
    segmentIds: {
      relay: parseTransactionSegmentId('segment:protocol:relay'),
      destination: parseTransactionSegmentId('segment:protocol:destination'),
      refund: parseTransactionSegmentId('segment:protocol:refund')
    },
    now: 200
  })
  const origin = applyTransactionSegmentEvent(bound.segments[0], {
    id: parseTransactionEventId('event:origin:broadcast'),
    status: 'broadcast',
    cause: 'progress',
    observedAt: 300,
    evidence: { transactionHash: '0xorigin' }
  })
  return parseTransactionGraph({
    root: reconcileTransactionRoot(bound.root, [origin, ...bound.segments.slice(1)], {
      id: parseTransactionEventId('event:root:broadcast'),
      observedAt: 300
    }),
    segments: [origin, ...bound.segments.slice(1)]
  })
}

class MemoryRepository {
  constructor(graph) {
    this.graph = graph
  }

  async create(graph) {
    this.graph = graph
    return { status: 'created', graph }
  }

  async get(requestScope, transactionId) {
    return requestScope.keyDomainId === scope.keyDomainId &&
      requestScope.accountId === scope.accountId &&
      transactionId === this.graph.root.id
      ? this.graph
      : null
  }

  async list(query) {
    return query.scope.keyDomainId === scope.keyDomainId &&
      query.scope.accountId === scope.accountId &&
      (!query.statuses || query.statuses.includes(this.graph.root.status))
      ? [this.graph]
      : []
  }

  async applySegmentEvent(input) {
    if (
      input.expectedRootRevision !== this.graph.root.revision ||
      input.expectedSegmentRevision !==
        this.graph.segments.find(segment => segment.id === input.segmentId)?.revision
    ) {
      return { status: 'revision-conflict' }
    }
    const segments = this.graph.segments.map(segment =>
      segment.id === input.segmentId ? applyTransactionSegmentEvent(segment, input.event) : segment
    )
    const root = reconcileTransactionRoot(this.graph.root, segments, {
      id: parseTransactionEventId(`event:root:${this.graph.root.revision + 1}`),
      observedAt: input.event.observedAt,
      allowReorg: input.event.cause === 'reorg'
    })
    this.graph = parseTransactionGraph({ root, segments })
    return { status: 'applied', graph: this.graph }
  }

  async hasAppliedEvent() {
    return false
  }

  async deleteByAccountScope() {
    return 0
  }
}

test.describe('Near Intents Transaction V2 monitor', () => {
  test('persists relay success and waits for destination Zcash finality', async () => {
    const repository = new MemoryRepository(protocolGraph())
    let confirmations = 3
    let eventSequence = 0
    const monitor = new NearIntentsTransactionMonitor({
      repository,
      now: () => 400 + eventSequence,
      createId: () => `test-${eventSequence++}`,
      fetchStatus: async () => ({
        status: 'SUCCESS',
        originAsset: 'nep141:eth.omft.near',
        destinationAsset: 'nep141:zec.omft.near',
        originTransactionHashes: ['0xorigin'],
        destinationTransactionHashes: ['zcash-destination']
      }),
      observeDestination: async () => ({
        status: confirmations >= 10 ? 'final' : 'confirming',
        confirmations,
        requiredConfirmations: 10
      })
    })

    expect(await monitor.poll([scope])).toMatchObject({ checked: 1, applied: 1, errors: 0 })
    expect(repository.graph.root.status).toBe('confirming')
    expect(repository.graph.segments.find(segment => segment.role === 'relay').status).toBe('final')
    expect(repository.graph.segments.find(segment => segment.role === 'destination')).toMatchObject(
      {
        status: 'confirming',
        evidence: {
          transactionHash: 'zcash-destination',
          confirmations: 3,
          requiredConfirmations: 10
        }
      }
    )

    confirmations = 10
    await monitor.poll([scope])
    expect(repository.graph.segments.find(segment => segment.role === 'destination').status).toBe(
      'final'
    )
    expect(repository.graph.root.status).toBe('confirming')
  })

  test('records a refund before making the required relay segment terminal', async () => {
    const repository = new MemoryRepository(protocolGraph())
    let eventSequence = 0
    const monitor = new NearIntentsTransactionMonitor({
      repository,
      now: () => 500 + eventSequence,
      createId: () => `refund-${eventSequence++}`,
      fetchStatus: async () => ({
        status: 'REFUNDED',
        originTransactionHashes: ['0xorigin', '0xrefund'],
        destinationTransactionHashes: []
      })
    })

    await monitor.poll([scope])
    expect(repository.graph.root.status).toBe('failed')
    expect(repository.graph.root.failure.code).toBe('refunded')
    expect(repository.graph.segments.find(segment => segment.role === 'refund')).toMatchObject({
      status: 'final',
      evidence: { transactionHash: '0xrefund' }
    })
    expect(repository.graph.segments.find(segment => segment.role === 'relay')).toMatchObject({
      status: 'failed',
      failure: { code: 'refunded' }
    })
  })

  test('makes supply destination final when protocol success has no destination hash', async () => {
    const repository = new MemoryRepository(protocolGraph('supply'))
    let eventSequence = 0
    const monitor = new NearIntentsTransactionMonitor({
      repository,
      now: () => 600 + eventSequence,
      createId: () => `supply-${eventSequence++}`,
      fetchStatus: async () => ({
        status: 'SUCCESS',
        originAsset: 'nep141:eth.omft.near',
        destinationAsset: 'nep141:zec.omft.near',
        originTransactionHashes: ['0xorigin'],
        destinationTransactionHashes: []
      })
    })

    expect(await monitor.poll([scope])).toMatchObject({ checked: 1, applied: 1, errors: 0 })
    expect(repository.graph.segments.find(segment => segment.role === 'relay')).toMatchObject({
      status: 'final',
      evidence: { externalReference: '0x2222222222222222222222222222222222222222' }
    })
    expect(repository.graph.segments.find(segment => segment.role === 'destination')).toMatchObject(
      {
        status: 'final',
        evidence: { externalReference: '0x2222222222222222222222222222222222222222' }
      }
    )
    expect(repository.graph.root.status).toBe('confirming')
  })

  test('fails closed when protocol status belongs to another quote asset', async () => {
    const repository = new MemoryRepository(protocolGraph())
    const monitor = new NearIntentsTransactionMonitor({
      repository,
      fetchStatus: async () => ({
        status: 'SUCCESS',
        originAsset: 'nep141:btc.omft.near',
        originTransactionHashes: [],
        destinationTransactionHashes: []
      })
    })
    expect(await monitor.poll([scope])).toMatchObject({ checked: 1, errors: 1, applied: 0 })
    expect(repository.graph.segments.find(segment => segment.role === 'relay').status).toBe(
      'created'
    )
  })
})
