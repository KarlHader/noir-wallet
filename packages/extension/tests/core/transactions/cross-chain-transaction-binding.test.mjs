import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  bindNearIntentsTransactionGraph,
  bindRheaSwapTransactionGraph,
  createRheaSwapSignedOrderGraph,
  parseNearIntentsTransactionBinding,
  parseRheaSwapTransactionBinding,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'

const EVM_CHAIN_ID = 'eip155:1'
const ZCASH_CHAIN_ID = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const EVM_ASSET_ID = `${EVM_CHAIN_ID}/slip44:60`
const ZEC_ASSET_ID = `${ZCASH_CHAIN_ID}/slip44:133`

function sourceGraph() {
  const transactionId = parseTransactionId('transaction:evm:cross-chain')
  const segmentId = parseTransactionSegmentId('segment:evm:cross-chain')
  return parseTransactionGraph({
    root: {
      id: transactionId,
      scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
      kind: 'transfer',
      status: 'prepared',
      segmentIds: [segmentId],
      createdAt: 100,
      updatedAt: 100,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId: EVM_ASSET_ID, amountRaw: '1000' },
        feeLimit: { assetId: EVM_ASSET_ID, amountRaw: '10' },
        sender: { chainId: EVM_CHAIN_ID, address: '0x1111111111111111111111111111111111111111' },
        recipient: {
          chainId: EVM_CHAIN_ID,
          address: '0x2222222222222222222222222222222222222222'
        }
      }
    },
    segments: [
      {
        id: segmentId,
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
}

function binding() {
  return {
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
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
  }
}

test.describe('Near Intents transaction binding', () => {
  test('creates an immutable origin, relay, destination, and optional refund graph', () => {
    const graph = bindNearIntentsTransactionGraph({
      graph: sourceGraph(),
      binding: binding(),
      segmentIds: {
        relay: parseTransactionSegmentId('segment:intents:relay'),
        destination: parseTransactionSegmentId('segment:intents:destination'),
        refund: parseTransactionSegmentId('segment:intents:refund')
      },
      now: 200
    })

    expect(graph.root.kind).toBe('swap')
    expect(graph.root.status).toBe('prepared')
    expect(graph.root.intent.counterAmount).toEqual({
      assetId: ZEC_ASSET_ID,
      amountRaw: '900'
    })
    expect(graph.root.intent.protocol).toEqual(binding())
    expect(graph.segments.map(segment => segment.role)).toEqual([
      'origin',
      'relay',
      'destination',
      'refund'
    ])
    expect(graph.segments[1]).toMatchObject({
      status: 'created',
      requiredForFinality: true,
      evidence: { externalReference: binding().depositAddress }
    })
    expect(graph.segments[2]).toMatchObject({
      target: { kind: 'onchain', chainId: ZCASH_CHAIN_ID },
      dependsOn: [graph.segments[1].id]
    })
    expect(graph.segments[3]).toMatchObject({
      target: { kind: 'onchain', chainId: EVM_CHAIN_ID },
      requiredForFinality: false
    })
  })

  test('rejects a quote that is expired or bound to another transfer', () => {
    expect(() =>
      bindNearIntentsTransactionGraph({
        graph: sourceGraph(),
        binding: { ...binding(), expiresAt: 199 },
        segmentIds: {
          relay: parseTransactionSegmentId('segment:intents:relay'),
          destination: parseTransactionSegmentId('segment:intents:destination'),
          refund: parseTransactionSegmentId('segment:intents:refund')
        },
        now: 200
      })
    ).toThrow(/does not match/)
    expect(() =>
      bindNearIntentsTransactionGraph({
        graph: sourceGraph(),
        binding: { ...binding(), depositAddress: '0x3333333333333333333333333333333333333333' },
        segmentIds: {
          relay: parseTransactionSegmentId('segment:intents:relay'),
          destination: parseTransactionSegmentId('segment:intents:destination'),
          refund: parseTransactionSegmentId('segment:intents:refund')
        },
        now: 200
      })
    ).toThrow(/does not match/)
  })

  test('projects a Supply destination as a RHEA position instead of a fake on-chain transfer', () => {
    const supplyBinding = {
      ...binding(),
      kind: 'supply',
      destination: {
        ...binding().destination,
        protocolAssetId: '1cs_v1:near:nep141:zec.omft.near',
        recipient: 'rhea00000x.multica.near'
      }
    }
    const graph = bindNearIntentsTransactionGraph({
      graph: sourceGraph(),
      binding: supplyBinding,
      segmentIds: {
        relay: parseTransactionSegmentId('segment:supply:relay'),
        destination: parseTransactionSegmentId('segment:supply:destination'),
        refund: parseTransactionSegmentId('segment:supply:refund')
      },
      now: 200
    })

    expect(graph.root.kind).toBe('supply')
    expect(graph.segments[2]).toMatchObject({
      role: 'destination',
      target: {
        kind: 'protocol',
        provider: 'RHEA Lending',
        account: 'rhea00000x.multica.near'
      }
    })
  })

  test('rejects malformed quote fields and minimum output above expected output', () => {
    expect(() =>
      parseNearIntentsTransactionBinding({
        ...binding(),
        destination: { ...binding().destination, minimumAmountRaw: '901' }
      })
    ).toThrow(/minimum amount exceeds/)
    expect(() => parseNearIntentsTransactionBinding({ ...binding(), extra: true })).toThrow(
      /invalid fields/
    )
  })
})

function rheaBinding() {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:one',
    executionId: 'execution-one',
    router: 'nearintents',
    sourceTarget: '0x2222222222222222222222222222222222222222',
    sender: '0x1111111111111111111111111111111111111111',
    originAmountRaw: '1000',
    expiresAt: 10_000,
    isCrossChain: true,
    origin: {
      chainId: EVM_CHAIN_ID,
      assetId: EVM_ASSET_ID,
      protocolChainId: '1',
      protocolAssetId: 'native'
    },
    destination: {
      chainId: ZCASH_CHAIN_ID,
      assetId: ZEC_ASSET_ID,
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
}

test.describe('RHEA CrossChainDex transaction binding', () => {
  test('persists a signed order with an order reference instead of a fake transaction hash', () => {
    const graph = createRheaSwapSignedOrderGraph({
      transactionId: parseTransactionId('transaction:rhea:signed-order'),
      scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
      binding: { ...rheaBinding(), sourceTarget: rheaBinding().sender },
      orderId: 'order-one',
      segmentIds: {
        origin: parseTransactionSegmentId('segment:rhea:order-origin'),
        relay: parseTransactionSegmentId('segment:rhea:order-relay'),
        destination: parseTransactionSegmentId('segment:rhea:order-destination'),
        refund: parseTransactionSegmentId('segment:rhea:order-refund')
      },
      now: 200
    })

    expect(() => assertPersistableTransactionGraph(graph)).not.toThrow()
    expect(graph.segments[0]).toMatchObject({
      role: 'origin',
      target: { kind: 'relay', provider: 'RHEA Signed Order' },
      evidence: { externalReference: 'order-one' }
    })
    expect(graph.segments[0].evidence.transactionHash).toBeUndefined()
  })

  test('binds source execution evidence and provider-specific recovery segments', () => {
    const graph = bindRheaSwapTransactionGraph({
      graph: sourceGraph(),
      binding: rheaBinding(),
      segmentIds: {
        relay: parseTransactionSegmentId('segment:rhea:relay'),
        destination: parseTransactionSegmentId('segment:rhea:destination'),
        refund: parseTransactionSegmentId('segment:rhea:refund')
      },
      now: 200
    })

    expect(graph.root.kind).toBe('swap')
    expect(graph.root.intent.protocol).toEqual(rheaBinding())
    expect(graph.root.intent.counterAmount).toEqual({ assetId: ZEC_ASSET_ID, amountRaw: '900' })
    expect(graph.segments[1]).toMatchObject({
      role: 'relay',
      target: { kind: 'relay', provider: 'RHEA CrossChainDex' },
      evidence: { externalReference: 'rhea-quote:one' },
      requiredForFinality: true
    })
  })

  test('records cross-chain Send as a transfer while retaining its RHEA binding', () => {
    const binding = { ...rheaBinding(), userAction: 'transfer' }
    const graph = bindRheaSwapTransactionGraph({
      graph: sourceGraph(),
      binding,
      segmentIds: {
        relay: parseTransactionSegmentId('segment:rhea:transfer-relay'),
        destination: parseTransactionSegmentId('segment:rhea:transfer-destination'),
        refund: parseTransactionSegmentId('segment:rhea:transfer-refund')
      },
      now: 200
    })
    expect(graph.root.kind).toBe('transfer')
    expect(graph.root.intent.protocol).toEqual(binding)
    expect(graph.segments.map(segment => segment.role)).toEqual([
      'origin',
      'relay',
      'destination',
      'refund'
    ])
    expect(() =>
      assertPersistableTransactionGraph({
        ...graph,
        root: { ...graph.root, status: 'signed' },
        segments: graph.segments.map(segment =>
          segment.role === 'origin'
            ? { ...segment, status: 'signed', evidence: { transactionHash: '0x123' } }
            : segment
        )
      })
    ).not.toThrow()
  })

  test('fails closed for altered source evidence and malformed destination bounds', () => {
    expect(() =>
      bindRheaSwapTransactionGraph({
        graph: sourceGraph(),
        binding: { ...rheaBinding(), originAmountRaw: '999' },
        segmentIds: {
          relay: parseTransactionSegmentId('segment:rhea:relay'),
          destination: parseTransactionSegmentId('segment:rhea:destination'),
          refund: parseTransactionSegmentId('segment:rhea:refund')
        },
        now: 200
      })
    ).toThrow(/does not match/)
    expect(() =>
      parseRheaSwapTransactionBinding({
        ...rheaBinding(),
        destination: { ...rheaBinding().destination, minimumAmountRaw: '901' }
      })
    ).toThrow(/minimum amount exceeds/)
  })
})
