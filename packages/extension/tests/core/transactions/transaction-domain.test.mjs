import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { parseAccountId } from '../../../src/core/accounts/domain/index.ts'
import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import { parseKeyDomainId } from '../../../src/core/keyring/domain/index.ts'
import {
  applyTransactionSegmentEvent,
  canTransitionTransactionStatus,
  deriveTransactionRootStatus,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionSegmentEvidence,
  parseTransactionId,
  parseTransactionSegmentId,
  reconcileTransactionRoot,
  validateTransactionGraph
} from '../../../src/core/transactions/domain/index.ts'

const transactionSource = readFileSync(
  new URL('../../../src/core/transactions/domain/transaction.ts', import.meta.url),
  'utf8'
)
const lifecycleSource = readFileSync(
  new URL('../../../src/core/transactions/domain/lifecycle.ts', import.meta.url),
  'utf8'
)
const validationSource = readFileSync(
  new URL('../../../src/core/transactions/domain/validation.ts', import.meta.url),
  'utf8'
)

const transactionId = parseTransactionId('transaction:1')
const keyDomainId = parseKeyDomainId('key-domain:1')
const accountId = parseAccountId('account:1')
const zcashChainId = parseChainId('bip122:00040fe8ec8471911baa1db1266ea15d').id
const nearChainId = parseChainId('near:mainnet').id
const evmChainId = parseChainId('eip155:1').id
const ethAssetId = 'eip155:1/slip44:60'

function segmentId(name) {
  return parseTransactionSegmentId(`segment:${name}`)
}

function eventId(name) {
  return parseTransactionEventId(`event:${name}`)
}

function createRoot(segmentIds, overrides = {}) {
  return {
    id: transactionId,
    scope: {
      keyDomainId,
      accountId
    },
    kind: 'withdraw',
    status: 'broadcast',
    segmentIds,
    createdAt: 1_000,
    updatedAt: 1_100,
    revision: 1,
    ...overrides
  }
}

function createSegment(id, role, target, overrides = {}) {
  return {
    id,
    transactionId,
    role,
    target,
    status: 'created',
    requiredForFinality: true,
    dependsOn: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 0,
    ...overrides
  }
}

test.describe('Unified transaction lifecycle', () => {
  test('persists a canonical immutable Activity intent snapshot', () => {
    const originId = segmentId('evm-origin')
    const intent = {
      schemaVersion: 1,
      direction: 'outgoing',
      primaryAmount: { assetId: ethAssetId, amountRaw: '125000000000000000' },
      feeLimit: { assetId: ethAssetId, amountRaw: '420000000000000' },
      sender: { chainId: evmChainId, address: `0x${'1'.repeat(40)}` },
      recipient: { chainId: evmChainId, address: `0x${'2'.repeat(40)}` }
    }
    const graph = parseTransactionGraph({
      root: createRoot([originId], {
        kind: 'transfer',
        status: 'prepared',
        intent
      }),
      segments: [
        createSegment(
          originId,
          'origin',
          { kind: 'onchain', chainId: evmChainId },
          {
            status: 'prepared'
          }
        )
      ]
    })

    expect(graph.root.intent).toEqual(intent)
    expect(Object.isFrozen(graph.root.intent)).toBe(true)
    expect(Object.isFrozen(graph.root.intent.primaryAmount)).toBe(true)

    const advanced = reconcileTransactionRoot(
      graph.root,
      [{ ...graph.segments[0], status: 'signed', updatedAt: 1_200, revision: 1 }],
      { id: eventId('intent-preserved'), observedAt: 1_200 }
    )
    expect(advanced.intent).toBe(graph.root.intent)
  })

  test('rejects malformed or ambiguous Activity intent amounts', () => {
    const originId = segmentId('invalid-intent')
    const graph = {
      root: createRoot([originId], {
        kind: 'transfer',
        intent: {
          schemaVersion: 1,
          direction: 'outgoing',
          primaryAmount: { assetId: ethAssetId, amountRaw: '01' }
        }
      }),
      segments: [
        createSegment(
          originId,
          'origin',
          { kind: 'onchain', chainId: evmChainId },
          {
            status: 'broadcast'
          }
        )
      ]
    }

    expect(() => parseTransactionGraph(graph)).toThrow(/primaryAmount/)
    expect(() =>
      parseTransactionGraph({
        ...graph,
        root: {
          ...graph.root,
          intent: { ...graph.root.intent, amount: '1' }
        }
      })
    ).toThrow(/intent snapshot/)
  })

  test('strictly validates persisted observed asset effects and their segment chain', () => {
    const effects = {
      source: 'receipt',
      completeness: 'partial',
      changes: [{ assetId: ethAssetId, amountRaw: '2', direction: 'outgoing' }]
    }
    const evidence = parseTransactionSegmentEvidence({
      transactionHash: '0xabc',
      assetEffects: effects
    })
    expect(evidence.assetEffects).toEqual(effects)
    expect(() => parseTransactionSegmentEvidence({ assetEffects: effects })).toThrow(/hash/)
    expect(() =>
      parseTransactionSegmentEvidence({
        transactionHash: '0xabc',
        assetEffects: { ...effects, changes: [{ ...effects.changes[0], amountRaw: '02' }] }
      })
    ).toThrow()
    expect(() =>
      parseTransactionSegmentEvidence({
        transactionHash: '0xabc',
        assetEffects: { ...effects, changes: [effects.changes[0], effects.changes[0]] }
      })
    ).toThrow(/Duplicate/)
    const originId = segmentId('observed-effects')
    expect(() =>
      parseTransactionGraph({
        root: createRoot([originId]),
        segments: [
          createSegment(originId, 'origin', { kind: 'onchain', chainId: nearChainId }, { evidence })
        ]
      })
    ).toThrow(/chain/)
  })

  test('allows forward reconciliation but only explicit non-terminal reorg downgrades', () => {
    expect(canTransitionTransactionStatus('created', 'signed', 'reconciliation')).toBe(true)
    expect(canTransitionTransactionStatus('broadcast', 'confirming', 'progress')).toBe(true)
    expect(canTransitionTransactionStatus('confirming', 'broadcast', 'progress')).toBe(false)
    expect(canTransitionTransactionStatus('confirming', 'broadcast', 'reorg')).toBe(true)
    expect(canTransitionTransactionStatus('final', 'confirming', 'reorg')).toBe(false)
    expect(canTransitionTransactionStatus('failed', 'created', 'reconciliation')).toBe(false)
  })

  test('applies events idempotently and ignores older observations', () => {
    const origin = createSegment(
      segmentId('origin'),
      'origin',
      { kind: 'onchain', chainId: nearChainId },
      { status: 'broadcast', updatedAt: 1_100, revision: 1 }
    )
    const confirmingEvent = {
      id: eventId('confirming'),
      status: 'confirming',
      cause: 'progress',
      observedAt: 1_200,
      evidence: {
        transactionHash: 'near-tx-hash',
        confirmations: 1,
        requiredConfirmations: 2
      }
    }
    const confirming = applyTransactionSegmentEvent(origin, confirmingEvent)

    expect(confirming.status).toBe('confirming')
    expect(confirming.revision).toBe(2)
    expect(applyTransactionSegmentEvent(confirming, confirmingEvent)).toBe(confirming)

    const stale = applyTransactionSegmentEvent(confirming, {
      id: eventId('stale'),
      status: 'broadcast',
      cause: 'reorg',
      observedAt: 1_150,
      evidence: {
        confirmations: 0
      }
    })
    expect(stale).toBe(confirming)
  })

  test('binds immutable chain evidence and requires an explicit reorg for decreases', () => {
    const confirming = createSegment(
      segmentId('origin'),
      'origin',
      { kind: 'onchain', chainId: nearChainId },
      {
        status: 'confirming',
        updatedAt: 1_200,
        revision: 2,
        evidence: {
          transactionHash: 'near-tx-hash',
          blockHash: 'near-block-hash:100',
          blockHeight: 100,
          confirmations: 2,
          requiredConfirmations: 3
        }
      }
    )

    expect(() =>
      applyTransactionSegmentEvent(confirming, {
        id: eventId('wrong-hash'),
        status: 'confirming',
        cause: 'progress',
        observedAt: 1_300,
        evidence: {
          transactionHash: 'different-hash',
          confirmations: 3
        }
      })
    ).toThrow(/transactionHash/)
    expect(() =>
      applyTransactionSegmentEvent(confirming, {
        id: eventId('implicit-reorg'),
        status: 'confirming',
        cause: 'progress',
        observedAt: 1_300,
        evidence: {
          blockHash: 'near-block-hash:99',
          confirmations: 0
        }
      })
    ).toThrow(/reorg/)

    const reorged = applyTransactionSegmentEvent(confirming, {
      id: eventId('explicit-reorg'),
      status: 'broadcast',
      cause: 'reorg',
      observedAt: 1_300,
      evidence: {
        confirmations: 0
      }
    })
    expect(reorged.status).toBe('broadcast')
    expect(reorged.evidence.confirmations).toBe(0)
    expect(reorged.evidence.transactionHash).toBe('near-tx-hash')
    expect(reorged.evidence.blockHash).toBeUndefined()
    expect(reorged.evidence.blockHeight).toBeUndefined()
    expect(reorged.reconfirming).toBe(true)

    const reconfirming = applyTransactionSegmentEvent(reorged, {
      id: eventId('reconfirming'),
      status: 'confirming',
      cause: 'progress',
      observedAt: 1_400,
      evidence: {
        blockHash: 'near-block-hash:replacement',
        blockHeight: 101,
        confirmations: 1
      }
    })
    expect(reconfirming.reconfirming).toBe(true)

    const refinalized = applyTransactionSegmentEvent(reconfirming, {
      id: eventId('refinalized'),
      status: 'final',
      cause: 'progress',
      observedAt: 1_500,
      evidence: { confirmations: 3 }
    })
    expect(refinalized.reconfirming).toBeUndefined()

    expect(() =>
      applyTransactionSegmentEvent(
        { ...confirming, status: 'final' },
        {
          id: eventId('terminal-reorg'),
          status: 'final',
          cause: 'reorg',
          observedAt: 1_300,
          evidence: { blockHash: 'near-block-hash:replacement' }
        }
      )
    ).toThrow(/Invalid transaction lifecycle transition/)
  })

  test('projects a required segment reorg onto the root until finality is restored', () => {
    const originId = segmentId('reconfirming-root')
    const root = createRoot([originId], {
      status: 'confirming',
      updatedAt: 1_200,
      revision: 2
    })
    const reorged = createSegment(
      originId,
      'origin',
      { kind: 'onchain', chainId: nearChainId },
      {
        status: 'broadcast',
        updatedAt: 1_300,
        revision: 3,
        reconfirming: true,
        evidence: {
          transactionHash: 'near-tx-hash',
          confirmations: 0,
          requiredConfirmations: 3
        }
      }
    )

    const reconfirmingRoot = reconcileTransactionRoot(root, [reorged], {
      id: eventId('root-reorg'),
      observedAt: 1_300,
      allowReorg: true
    })
    expect(reconfirmingRoot).toMatchObject({ status: 'broadcast', reconfirming: true })

    const refinalized = { ...reorged, status: 'final', reconfirming: undefined }
    const finalRoot = reconcileTransactionRoot(reconfirmingRoot, [refinalized], {
      id: eventId('root-refinalized'),
      observedAt: 1_500
    })
    expect(finalRoot.status).toBe('final')
    expect(finalRoot.reconfirming).toBeUndefined()
  })

  test('requires evidence-backed failure and never reopens a terminal segment', () => {
    const origin = createSegment(segmentId('origin'), 'origin', {
      kind: 'onchain',
      chainId: nearChainId
    })

    expect(() =>
      applyTransactionSegmentEvent(origin, {
        id: eventId('missing-failure'),
        status: 'failed',
        cause: 'failure',
        observedAt: 1_100
      })
    ).toThrow(/failure reason/)

    const failed = applyTransactionSegmentEvent(origin, {
      id: eventId('failed'),
      status: 'failed',
      cause: 'failure',
      observedAt: 1_100,
      failure: {
        code: 'relay-failed',
        occurredAt: 1_090
      }
    })
    expect(() =>
      applyTransactionSegmentEvent(failed, {
        id: eventId('reopen'),
        status: 'confirming',
        cause: 'reconciliation',
        observedAt: 1_200
      })
    ).toThrow(/Invalid transaction lifecycle transition/)
  })

  test('models retries and replacements as new roots instead of reopening terminal history', () => {
    const failedRoot = createRoot([], {
      status: 'failed',
      failure: {
        code: 'expired',
        occurredAt: 1_100
      }
    })
    const retryRoot = {
      ...createRoot([], {
        id: parseTransactionId('transaction:retry'),
        status: 'created',
        updatedAt: 1_200
      }),
      relation: {
        kind: 'retry-of',
        transactionId: failedRoot.id
      }
    }

    validateTransactionGraph(retryRoot, [])
    expect(retryRoot.id).not.toBe(failedRoot.id)
    expect(retryRoot.relation.transactionId).toBe(failedRoot.id)
    expect(
      reconcileTransactionRoot(failedRoot, [], {
        id: eventId('cannot-reopen-root'),
        observedAt: 1_300,
        allowReorg: true
      })
    ).toBe(failedRoot)
  })

  test('derives a withdraw root from ordered origin, relay, and destination segments', () => {
    const originId = segmentId('origin')
    const relayId = segmentId('relay')
    const destinationId = segmentId('destination')
    const root = createRoot([originId, relayId, destinationId])
    const origin = createSegment(
      originId,
      'origin',
      { kind: 'onchain', chainId: nearChainId },
      { status: 'final' }
    )
    const relay = createSegment(
      relayId,
      'relay',
      { kind: 'relay', provider: 'near-intents' },
      {
        status: 'final',
        dependsOn: [originId],
        evidence: { externalReference: 'relay-deposit:1' }
      }
    )
    const destination = createSegment(
      destinationId,
      'destination',
      { kind: 'onchain', chainId: zcashChainId },
      {
        status: 'confirming',
        dependsOn: [relayId],
        evidence: {
          transactionHash: 'zcash-destination-hash',
          confirmations: 3,
          requiredConfirmations: 10
        }
      }
    )

    validateTransactionGraph(root, [destination, origin, relay])
    expect(deriveTransactionRootStatus([origin, relay, destination])).toBe('confirming')

    const confirmingRoot = reconcileTransactionRoot(root, [origin, relay, destination], {
      id: eventId('root-confirming'),
      observedAt: 1_300
    })
    expect(confirmingRoot.status).toBe('confirming')

    const finalDestination = { ...destination, status: 'final', updatedAt: 1_400, revision: 1 }
    const finalRoot = reconcileTransactionRoot(confirmingRoot, [origin, relay, finalDestination], {
      id: eventId('root-final'),
      observedAt: 1_400
    })
    expect(finalRoot.status).toBe('final')

    const staleDestination = { ...destination, status: 'broadcast', updatedAt: 1_500, revision: 2 }
    expect(
      reconcileTransactionRoot(finalRoot, [origin, relay, staleDestination], {
        id: eventId('late-reorg'),
        observedAt: 1_500,
        allowReorg: true
      })
    ).toBe(finalRoot)
  })

  test('fails the root only from a required segment and ignores optional diagnostics', () => {
    const originId = segmentId('origin')
    const relayId = segmentId('relay')
    const refundId = segmentId('refund')
    const root = createRoot([originId, relayId, refundId], { kind: 'swap' })
    const origin = createSegment(
      originId,
      'origin',
      { kind: 'onchain', chainId: zcashChainId },
      { status: 'final' }
    )
    const relay = createSegment(
      relayId,
      'relay',
      { kind: 'relay', provider: 'near-intents' },
      {
        status: 'failed',
        dependsOn: [originId],
        failure: {
          code: 'relay-failed',
          occurredAt: 1_200
        }
      }
    )
    const refund = createSegment(
      refundId,
      'refund',
      { kind: 'onchain', chainId: zcashChainId },
      {
        status: 'confirming',
        requiredForFinality: false,
        dependsOn: [relayId]
      }
    )

    expect(deriveTransactionRootStatus([origin, relay, refund])).toBe('failed')
    const failedRoot = reconcileTransactionRoot(root, [origin, relay, refund], {
      id: eventId('root-failed'),
      observedAt: 1_300
    })
    expect(failedRoot.status).toBe('failed')
    expect(failedRoot.failure.code).toBe('relay-failed')

    const optionalFailure = { ...refund, status: 'failed', failure: relay.failure }
    expect(deriveTransactionRootStatus([origin, optionalFailure])).toBe('final')
  })

  test('rejects cycles, forward dependencies, and mismatched roots', () => {
    const originId = segmentId('origin')
    const relayId = segmentId('relay')
    const root = createRoot([originId, relayId])
    const origin = createSegment(originId, 'origin', {
      kind: 'onchain',
      chainId: nearChainId
    })
    const relay = createSegment(
      relayId,
      'relay',
      { kind: 'relay', provider: 'near-intents' },
      { dependsOn: [relayId] }
    )

    expect(() => validateTransactionGraph(root, [origin, relay])).toThrow(/earlier segment/)
    expect(() =>
      validateTransactionGraph(root, [
        origin,
        { ...relay, transactionId: parseTransactionId('transaction:other') }
      ])
    ).toThrow(/does not belong/)
  })

  test('keeps the new domain independent from V1 status and runtime frameworks', () => {
    const source = `${transactionSource}\n${lifecycleSource}\n${validationSource}`

    expect(source).not.toMatch(/relay_confirmed|from ['"]@\/types/)
    expect(source).not.toMatch(/chrome\.|react|zustand|indexed-db|WORKER_RPC/i)
    expect(source).not.toMatch(/console\.(?:log|warn|error)/)
  })
})
