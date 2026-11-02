import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseAccountId } from '../../../src/core/accounts/domain/index.ts'
import {
  buildActivityReadModel,
  mapTransactionGraphToActivityItem,
  parseActivityReadModel
} from '../../../src/core/activity/index.ts'
import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import { parseKeyDomainId } from '../../../src/core/keyring/domain/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'
import {
  filterActivityItems,
  groupActivityItemsByDate
} from '../../../src/popup/services/activity-list-model.ts'

const scope = {
  keyDomainId: parseKeyDomainId('key-domain:activity'),
  accountId: parseAccountId('account:activity')
}
const evmChainId = parseChainId('eip155:1').id
const arbitrumChainId = parseChainId('eip155:42161').id
const zcashChainId = parseChainId('bip122:00040fe8ec8471911baa1db1266ea15d').id
const bitcoinChainId = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const ethAssetId = 'eip155:1/slip44:60'
const usdcAssetId = `eip155:1/erc20:0x${'3'.repeat(40)}`
const zecAssetId = `${zcashChainId}/slip44:133`
const btcAssetId = `${bitcoinChainId}/slip44:0`
const evmHash = `0x${'A'.repeat(64)}`
const peaAddress = '0x9999999999999999999999999999999999999999'

function graph({
  id = 'transaction:activity',
  chainId = evmChainId,
  assetId = ethAssetId,
  hash = evmHash,
  intent = true,
  updatedAt = 1_100
} = {}) {
  const transactionId = parseTransactionId(id)
  const segmentId = parseTransactionSegmentId(`${id}:origin`)
  return {
    root: {
      id: transactionId,
      scope,
      kind: 'transfer',
      status: 'broadcast',
      segmentIds: [segmentId],
      createdAt: 1_000,
      updatedAt,
      revision: 1,
      ...(intent
        ? {
            intent: {
              schemaVersion: 1,
              direction: 'outgoing',
              primaryAmount: { assetId, amountRaw: '100' }
            }
          }
        : {})
    },
    segments: [
      {
        id: segmentId,
        transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status: 'broadcast',
        requiredForFinality: true,
        dependsOn: [],
        evidence: { transactionHash: hash },
        createdAt: 1_000,
        updatedAt,
        revision: 1
      }
    ]
  }
}

function supplemental({
  id,
  source,
  chainId,
  assetId,
  hash,
  createdAt = 900,
  updatedAt,
  itemScope = scope
}) {
  return Object.freeze({
    id,
    source,
    scope: itemScope,
    kind: 'transfer',
    status: 'final',
    snapshot: {
      schemaVersion: 1,
      direction: 'incoming',
      primaryAmount: { assetId, amountRaw: '100' }
    },
    segments: [
      {
        id: `${id}:origin`,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status: 'final',
        evidence: { transactionHash: hash }
      }
    ],
    completeness: 'complete',
    createdAt,
    updatedAt
  })
}

test.describe('Activity read model', () => {
  test('orders cross-chain source and destination records by transaction time', () => {
    const origin = graph({ id: 'transaction:cross-chain', updatedAt: 2_000 })
    const received = supplemental({
      id: 'rpc:arbitrum:received',
      source: 'rpc',
      chainId: arbitrumChainId,
      assetId: `${arbitrumChainId}/slip44:60`,
      hash: `0x${'b'.repeat(64)}`,
      createdAt: 1_500,
      updatedAt: 1_500
    })
    const model = buildActivityReadModel({
      scope,
      localGraphs: [origin],
      supplementalItems: [received]
    })

    expect(model.items.map(item => item.id)).toEqual([
      'rpc:arbitrum:received',
      'transaction:cross-chain'
    ])
  })

  test('groups activity by transaction date rather than its last status update', () => {
    const today = new Date(2026, 9, 1, 12).getTime()
    const yesterday = new Date(2026, 8, 30, 23).getTime()
    const item = supplemental({
      id: 'rpc:updated-today',
      source: 'rpc',
      chainId: evmChainId,
      assetId: ethAssetId,
      hash: `0x${'c'.repeat(64)}`,
      createdAt: yesterday,
      updatedAt: today
    })

    expect(groupActivityItemsByDate([item], today)[0][0]).toBe('Yesterday')
  })

  test('maps the immutable local intent and chain evidence without recomputing display data', () => {
    const item = mapTransactionGraphToActivityItem(graph())

    expect(item).toMatchObject({
      id: 'transaction:activity',
      source: 'wallet-v2',
      status: 'broadcast',
      completeness: 'complete',
      snapshot: {
        direction: 'outgoing',
        primaryAmount: { assetId: ethAssetId, amountRaw: '100' }
      },
      segments: [
        {
          target: { kind: 'onchain', chainId: evmChainId },
          evidence: { transactionHash: evmHash }
        }
      ]
    })
  })

  test('classifies Global PEA local and supplemental activity without changing Main defaults', () => {
    const privateGraph = graph({ id: 'transaction:private' })
    privateGraph.root.intent.sender = { chainId: evmChainId, address: peaAddress }
    const privateRemote = {
      ...supplemental({
        id: 'rpc:evm:private',
        source: 'rpc',
        chainId: evmChainId,
        assetId: ethAssetId,
        hash: `0x${'9'.repeat(64)}`,
        updatedAt: 1_300
      }),
      accountMode: 'private'
    }
    const model = buildActivityReadModel({
      scope,
      localGraphs: [privateGraph, graph({ id: 'transaction:main', hash: `0x${'8'.repeat(64)}` })],
      supplementalItems: [privateRemote],
      privateExecutionAddresses: [peaAddress]
    })

    expect(model.items.find(item => item.id === 'transaction:private')?.accountMode).toBe('private')
    expect(model.items.find(item => item.id === 'rpc:evm:private')?.accountMode).toBe('private')
    expect(model.items.find(item => item.id === 'transaction:main')?.accountMode).toBeUndefined()
    expect(parseActivityReadModel(structuredClone(model))).toEqual(model)
  })

  test('attributes wallet-originated activity to its signer and incoming activity to its recipient', () => {
    const mainToPrivate = graph({ id: 'transaction:main-to-private' })
    mainToPrivate.root.intent.sender = {
      chainId: evmChainId,
      address: '0x1111111111111111111111111111111111111111'
    }
    mainToPrivate.root.intent.recipient = { chainId: evmChainId, address: peaAddress }
    const privateToMain = graph({
      id: 'transaction:private-to-main',
      hash: `0x${'8'.repeat(64)}`
    })
    privateToMain.root.intent.sender = { chainId: evmChainId, address: peaAddress }
    privateToMain.root.intent.recipient = {
      chainId: evmChainId,
      address: '0x1111111111111111111111111111111111111111'
    }
    const mainContractCall = graph({
      id: 'transaction:main-contract-call',
      hash: `0x${'7'.repeat(64)}`
    })
    mainContractCall.root.kind = 'contract-call'
    mainContractCall.root.intent.direction = 'contract'
    mainContractCall.root.intent.sender = mainToPrivate.root.intent.sender
    mainContractCall.root.intent.recipient = { chainId: evmChainId, address: peaAddress }
    const incomingPrivate = graph({
      id: 'transaction:incoming-private',
      hash: `0x${'6'.repeat(64)}`
    })
    incomingPrivate.root.kind = 'receive'
    incomingPrivate.root.intent.direction = 'incoming'
    incomingPrivate.root.intent.sender = mainToPrivate.root.intent.sender
    incomingPrivate.root.intent.recipient = { chainId: evmChainId, address: peaAddress }

    const model = buildActivityReadModel({
      scope,
      localGraphs: [mainToPrivate, privateToMain, mainContractCall, incomingPrivate],
      privateExecutionAddresses: [peaAddress]
    })
    expect(model.items.find(item => item.id === mainToPrivate.root.id)?.accountMode).toBeUndefined()
    expect(model.items.find(item => item.id === privateToMain.root.id)?.accountMode).toBe('private')
    expect(
      model.items.find(item => item.id === mainContractCall.root.id)?.accountMode
    ).toBeUndefined()
    expect(model.items.find(item => item.id === incomingPrivate.root.id)?.accountMode).toBe(
      'private'
    )
    const selection = {
      items: model.items,
      selectedChainIds: [evmChainId]
    }
    expect(
      filterActivityItems(selection)
        .map(item => item.id)
        .sort()
    ).toEqual(
      [
        incomingPrivate.root.id,
        mainContractCall.root.id,
        mainToPrivate.root.id,
        privateToMain.root.id
      ].sort()
    )
  })

  test('preserves a persisted pre-finality reorg through the strict Activity boundary', () => {
    const value = graph()
    value.root.reconfirming = true
    value.segments[0].reconfirming = true
    value.segments[0].evidence = {
      ...value.segments[0].evidence,
      confirmations: 0,
      requiredConfirmations: 2
    }

    const item = mapTransactionGraphToActivityItem(value)
    expect(item).toMatchObject({ status: 'broadcast', reconfirming: true })
    expect(item.segments[0]).toMatchObject({ status: 'broadcast', reconfirming: true })

    const parsed = parseActivityReadModel({
      scope,
      items: [item],
      partialItemCount: 0
    })
    expect(parsed.items[0].reconfirming).toBe(true)
    expect(parsed.items[0].segments[0].reconfirming).toBe(true)

    expect(() =>
      parseActivityReadModel({
        scope,
        items: [{ ...item, status: 'final' }],
        partialItemCount: 0
      })
    ).toThrow(/reconfirming/)
  })

  test('keeps Zcash V1 authoritative and uses RPC only for distinct history', () => {
    const localZcash = graph({
      id: 'transaction:zcash-shadow',
      chainId: zcashChainId,
      assetId: zecAssetId,
      hash: 'ABCDEF',
      updatedAt: 1_300
    })
    const zcashV1 = supplemental({
      id: 'zcash-v1:ABCDEF',
      source: 'zcash-v1',
      chainId: zcashChainId,
      assetId: zecAssetId,
      hash: 'abcdef',
      updatedAt: 1_100
    })
    const remoteDuplicate = supplemental({
      id: 'rpc:zcash:ABCDEF',
      source: 'rpc',
      chainId: zcashChainId,
      assetId: zecAssetId,
      hash: 'ABCDEF',
      updatedAt: 1_400
    })
    const remoteExternal = supplemental({
      id: 'rpc:evm:external',
      source: 'rpc',
      chainId: evmChainId,
      assetId: ethAssetId,
      hash: `0x${'b'.repeat(64)}`,
      updatedAt: 1_200
    })

    const model = buildActivityReadModel({
      scope,
      localGraphs: [localZcash],
      supplementalItems: [remoteDuplicate, remoteExternal, zcashV1]
    })

    expect(model.items.map(item => item.id)).toEqual(['rpc:evm:external', 'zcash-v1:ABCDEF'])
    expect(model.items.find(item => item.id === 'zcash-v1:ABCDEF')?.source).toBe('zcash-v1')
  })

  test('keeps a wallet-created non-Zcash transaction ahead of its RPC duplicate', () => {
    const remoteDuplicate = supplemental({
      id: 'rpc:evm:duplicate',
      source: 'rpc',
      chainId: evmChainId,
      assetId: ethAssetId,
      hash: evmHash.toLowerCase(),
      updatedAt: 1_500
    })
    const model = buildActivityReadModel({
      scope,
      localGraphs: [graph()],
      supplementalItems: [remoteDuplicate]
    })

    expect(model.items).toHaveLength(1)
    expect(model.items[0]).toMatchObject({ id: 'transaction:activity', source: 'wallet-v2' })
  })

  test('merges observed assets by chain and hash without changing the wallet intent', () => {
    const local = graph()
    local.root.kind = 'contract-call'
    local.root.intent.direction = 'contract'
    delete local.root.intent.primaryAmount
    const observed = supplemental({
      id: 'rpc:evm:observed',
      source: 'rpc',
      chainId: evmChainId,
      assetId: usdcAssetId,
      hash: evmHash.toLowerCase(),
      updatedAt: 1_500
    })
    observed.segments[0].evidence.assetEffects = {
      source: 'indexer',
      completeness: 'partial',
      changes: [{ assetId: usdcAssetId, amountRaw: '5000000', direction: 'outgoing' }]
    }
    const model = buildActivityReadModel({
      scope,
      localGraphs: [local],
      supplementalItems: [observed]
    })
    expect(model.items).toHaveLength(1)
    expect(model.items[0].snapshot).toEqual(local.root.intent)
    expect(model.items[0].segments[0].evidence.assetEffects).toEqual(
      observed.segments[0].evidence.assetEffects
    )
    expect(
      filterActivityItems({
        items: model.items,
        selectedChainIds: [evmChainId],
        assetId: usdcAssetId
      })
    ).toHaveLength(1)
    expect(parseActivityReadModel(structuredClone(model))).toEqual(model)

    local.segments[0].evidence.assetEffects = {
      source: 'receipt',
      completeness: 'partial',
      changes: [{ assetId: ethAssetId, amountRaw: '1', direction: 'outgoing' }]
    }
    expect(
      buildActivityReadModel({ scope, localGraphs: [local], supplementalItems: [observed] })
        .items[0].segments[0].evidence.assetEffects.source
    ).toBe('receipt')
    local.segments[0].evidence.blockHash = `0x${'1'.repeat(64)}`
    observed.segments[0].evidence.blockHash = `0x${'2'.repeat(64)}`
    expect(
      buildActivityReadModel({ scope, localGraphs: [local], supplementalItems: [observed] })
        .items[0].segments[0].evidence.blockHash
    ).toBe(local.segments[0].evidence.blockHash)
    delete local.segments[0].evidence.blockHash
    delete observed.segments[0].evidence.blockHash
    local.root.status = 'final'
    local.segments[0].status = 'final'
    const failedRpc = {
      ...observed,
      status: 'failed',
      failureCode: 'reverted',
      segments: [{ ...observed.segments[0], status: 'failed', failureCode: 'reverted' }]
    }
    const confirmed = buildActivityReadModel({
      scope,
      localGraphs: [local],
      supplementalItems: [failedRpc]
    })
    expect(confirmed.items[0].status).toBe('final')
    expect(confirmed.items[0].segments[0].evidence.assetEffects.source).toBe('receipt')
    local.root.status = 'broadcast'
    local.segments[0].status = 'broadcast'
    local.root.reconfirming = true
    local.segments[0].reconfirming = true
    const reconfirming = buildActivityReadModel({
      scope,
      localGraphs: [local],
      supplementalItems: [observed]
    })
    expect(reconfirming.items[0].segments[0].evidence.assetEffects).toBeUndefined()
  })

  test('keeps the destination receipt beside a local cross-chain transfer', () => {
    const transfer = graph()
    const destinationId = parseTransactionSegmentId(`${transfer.root.id}:destination`)
    const destinationHash = `0x${'B'.repeat(64)}`
    transfer.root.segmentIds.push(destinationId)
    transfer.segments.push({
      id: destinationId,
      transactionId: transfer.root.id,
      role: 'destination',
      target: { kind: 'onchain', chainId: arbitrumChainId },
      status: 'broadcast',
      requiredForFinality: true,
      dependsOn: [transfer.segments[0].id],
      evidence: { transactionHash: destinationHash },
      createdAt: 1_000,
      updatedAt: 1_100,
      revision: 1
    })
    const receipt = supplemental({
      id: 'rpc:evm:destination',
      source: 'rpc',
      chainId: arbitrumChainId,
      assetId: 'eip155:42161/slip44:60',
      hash: destinationHash.toLowerCase(),
      updatedAt: 1_200
    })
    const model = buildActivityReadModel({
      scope,
      localGraphs: [transfer],
      supplementalItems: [receipt]
    })

    expect(model.items.map(item => item.id)).toContain(transfer.root.id)
    expect(model.items.map(item => item.id)).toContain(receipt.id)
    expect(
      filterActivityItems({ items: model.items, selectedChainIds: [arbitrumChainId] }).map(
        item => item.id
      )
    ).toContain(receipt.id)
  })

  test('keeps a wallet-created Bitcoin transaction ahead of its Esplora duplicate', () => {
    const bitcoinHash = 'A'.repeat(64)
    const remoteDuplicate = supplemental({
      id: `rpc:bitcoin:${bitcoinHash.toLowerCase()}`,
      source: 'rpc',
      chainId: bitcoinChainId,
      assetId: btcAssetId,
      hash: bitcoinHash.toLowerCase(),
      updatedAt: 1_500
    })
    const model = buildActivityReadModel({
      scope,
      localGraphs: [
        graph({
          id: 'transaction:bitcoin:activity',
          chainId: bitcoinChainId,
          assetId: btcAssetId,
          hash: bitcoinHash
        })
      ],
      supplementalItems: [remoteDuplicate]
    })

    expect(model.items).toHaveLength(1)
    expect(model.items[0]).toMatchObject({
      id: 'transaction:bitcoin:activity',
      source: 'wallet-v2'
    })
  })

  test('reports legacy local graphs without an intent as partial instead of fabricating fields', () => {
    const model = buildActivityReadModel({ scope, localGraphs: [graph({ intent: false })] })

    expect(model.items[0].snapshot).toBeUndefined()
    expect(model.items[0].completeness).toBe('partial')
    expect(model.partialItemCount).toBe(1)
  })

  test('hides legacy user cancellations that were never broadcast', () => {
    const cancelled = graph({ id: 'transaction:cancelled-before-broadcast' })
    cancelled.root.status = 'failed'
    cancelled.root.failure = { code: 'user-rejected', occurredAt: 1_100 }
    cancelled.segments[0].status = 'failed'
    cancelled.segments[0].failure = { code: 'user-rejected', occurredAt: 1_100 }
    delete cancelled.segments[0].evidence

    const model = buildActivityReadModel({ scope, localGraphs: [cancelled] })

    expect(model.items).toEqual([])
  })

  test('keeps failed transactions with broadcast evidence visible', () => {
    const failedAfterBroadcast = graph({ id: 'transaction:failed-after-broadcast' })
    failedAfterBroadcast.root.status = 'failed'
    failedAfterBroadcast.root.failure = { code: 'cancelled', occurredAt: 1_100 }
    failedAfterBroadcast.segments[0].status = 'failed'
    failedAfterBroadcast.segments[0].failure = { code: 'cancelled', occurredAt: 1_100 }

    const model = buildActivityReadModel({ scope, localGraphs: [failedAfterBroadcast] })

    expect(model.items).toHaveLength(1)
  })

  test('rejects supplemental history crossing the requested Account scope', () => {
    const wrongScope = {
      ...scope,
      accountId: parseAccountId('account:other')
    }
    expect(() =>
      buildActivityReadModel({
        scope,
        localGraphs: [],
        supplementalItems: [
          supplemental({
            id: 'rpc:wrong-scope',
            source: 'rpc',
            chainId: evmChainId,
            assetId: ethAssetId,
            hash: `0x${'c'.repeat(64)}`,
            updatedAt: 1_000,
            itemScope: wrongScope
          })
        ]
      })
    ).toThrow(/Account scope/)
  })

  test('strictly parses the bounded Activity projection used by the Popup', () => {
    const value = structuredClone(
      buildActivityReadModel({
        scope,
        localGraphs: [graph()],
        supplementalItems: [
          supplemental({
            id: 'rpc:external',
            source: 'rpc',
            chainId: zcashChainId,
            assetId: zecAssetId,
            hash: 'external-hash',
            updatedAt: 1_200
          })
        ]
      })
    )

    const parsed = parseActivityReadModel(value)

    expect(parsed.items.map(item => item.id)).toEqual(['transaction:activity', 'rpc:external'])
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.items)).toBe(true)
    expect(Object.isFrozen(parsed.items[0].snapshot)).toBe(true)
  })

  test('rejects substituted fields, scope mismatches, and dishonest partial counts', () => {
    const valid = structuredClone(buildActivityReadModel({ scope, localGraphs: [graph()] }))

    expect(() => parseActivityReadModel({ ...valid, internalCommandId: 'secret' })).toThrow(
      /Activity read model/
    )
    expect(() =>
      parseActivityReadModel({
        ...valid,
        items: [{ ...valid.items[0], scope: { ...scope, accountId: 'account:other' } }]
      })
    ).toThrow(/scope/)
    expect(() =>
      parseActivityReadModel({
        ...valid,
        scope: { ...valid.scope, walletId: 'wallet:unexpected' }
      })
    ).toThrow(/scope/)
    expect(() => parseActivityReadModel({ ...valid, partialItemCount: 1 })).toThrow(
      /partial item count/
    )
    expect(() =>
      parseActivityReadModel({
        ...valid,
        items: [
          {
            ...valid.items[0],
            snapshot: {
              ...valid.items[0].snapshot,
              recipient: {
                chainId: zcashChainId,
                address: '0x1111111111111111111111111111111111111111\nspoofed'
              }
            }
          }
        ]
      })
    ).toThrow(/bounded non-empty string/)
  })
})
