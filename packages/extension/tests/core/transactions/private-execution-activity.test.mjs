import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildActivityReadModel,
  inferPrivateExecutionAddressFromLocalGraphs
} from '../../../src/core/activity/index.ts'
import { ActivityCoordinator } from '../../../src/infrastructure/activity/activity-coordinator.ts'

const scope = { keyDomainId: 'wallet:private-activity', accountId: 'account:private-activity' }
const otherScope = { keyDomainId: 'wallet:other', accountId: 'account:other' }
const main = `0x${'1'.repeat(40)}`
const privateAddress = `0x${'9'.repeat(40)}`
const chainId = 'eip155:1'

function graph(id, sender, recipient, options = {}) {
  const graphScope = options.scope ?? scope
  const segmentId = `${id}:origin`
  const direction = options.direction ?? 'outgoing'
  return {
    root: {
      id,
      scope: graphScope,
      kind: direction === 'incoming' ? 'receive' : 'transfer',
      status: 'prepared',
      segmentIds: [segmentId],
      createdAt: 1_000,
      updatedAt: 1_000,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction,
        primaryAmount: { assetId: `${chainId}/slip44:60`, amountRaw: '100' },
        sender: { chainId: options.chainId ?? chainId, address: sender },
        recipient: { chainId: options.chainId ?? chainId, address: recipient },
        ...(options.withoutEvm
          ? {}
          : {
              evm: {
                schemaVersion: 1,
                nonce: '1',
                maxFeePerGasWei: '2',
                maxPriorityFeePerGasWei: '1',
                gasLimit: '21000'
              }
            })
      }
    },
    segments: [
      {
        id: segmentId,
        transactionId: id,
        role: 'origin',
        target: { kind: 'onchain', chainId: options.chainId ?? chainId },
        status: 'prepared',
        requiredForFinality: true,
        dependsOn: [],
        createdAt: 1_000,
        updatedAt: 1_000,
        revision: 0
      }
    ]
  }
}

test('recovers only a scoped EVM signer from persisted local transaction intent', () => {
  const privateGraph = graph('transaction:private', privateAddress, main)
  const mainToPrivate = graph('transaction:main-to-private', main, privateAddress)
  assert.equal(
    inferPrivateExecutionAddressFromLocalGraphs(
      [
        mainToPrivate,
        graph('transaction:other-scope', `0x${'8'.repeat(40)}`, main, {
          scope: otherScope
        }),
        graph('transaction:non-evm', `0x${'7'.repeat(40)}`, main, {
          chainId: 'bip122:000000000019d6689c085ae165831e93'
        }),
        graph('transaction:no-evm-intent', `0x${'6'.repeat(40)}`, main, { withoutEvm: true }),
        privateGraph
      ],
      scope,
      main
    ),
    privateAddress
  )
  assert.equal(inferPrivateExecutionAddressFromLocalGraphs([mainToPrivate], scope, main), null)
  assert.equal(
    inferPrivateExecutionAddressFromLocalGraphs(
      [privateGraph, graph('transaction:conflict', `0x${'8'.repeat(40)}`, main)],
      scope,
      main
    ),
    null
  )
})

test('retains signer and recipient ownership when Private derivation is unavailable', () => {
  const graphs = [
    graph('transaction:private', privateAddress, main),
    graph('transaction:main-to-private', main, privateAddress),
    graph('transaction:incoming-private', main, privateAddress, { direction: 'incoming' })
  ]
  const inferred = inferPrivateExecutionAddressFromLocalGraphs(graphs, scope, main)
  assert.equal(inferred, privateAddress)
  const model = buildActivityReadModel({
    scope,
    localGraphs: graphs,
    privateExecutionAddresses: [inferred]
  })
  const modes = Object.fromEntries(model.items.map(item => [item.id, item.accountMode]))
  assert.equal(modes['transaction:private'], 'private')
  assert.equal(modes['transaction:main-to-private'], undefined)
  assert.equal(modes['transaction:incoming-private'], 'private')
})

test('reconstructs Private Activity from scoped graphs across independent coordinator reads', async () => {
  const graphs = [
    graph('transaction:private', privateAddress, main),
    graph('transaction:main', main, `0x${'2'.repeat(40)}`)
  ]
  const pointer = {
    generationId: 'metadata:generation:private-activity',
    sourceFingerprint: 'a'.repeat(64)
  }
  const storageRepository = {
    getActivePointer: async () => pointer,
    getSnapshot: async () => ({
      manifest: {
        status: 'verified',
        generationId: pointer.generationId,
        sourceFingerprint: pointer.sourceFingerprint,
        activeAccount: scope
      }
    })
  }
  const options = {
    storageRepository,
    transactionRepository: { list: async () => graphs },
    loadZcashTransactions: async () => [],
    loadPrivateExecutionAddresses: async (activeScope, localGraphs) => {
      const inferred = inferPrivateExecutionAddressFromLocalGraphs(localGraphs, activeScope, main)
      return inferred ? [inferred] : []
    }
  }

  for (const context of ['popup', 'worker']) {
    const model = await new ActivityCoordinator(options).readActive({
      includeSupplemental: false,
      accountMode: 'all'
    })
    assert.equal(
      model?.items.find(item => item.id === 'transaction:private')?.accountMode,
      'private',
      context
    )
    assert.equal(
      model?.items.find(item => item.id === 'transaction:main')?.accountMode,
      undefined,
      context
    )
  }
})
