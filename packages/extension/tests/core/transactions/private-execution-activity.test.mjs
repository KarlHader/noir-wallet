import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildActivityReadModel,
  inferPrivateExecutionAddressFromLocalGraphs
} from '../../../src/core/activity/index.ts'
import { ActivityCoordinator } from '../../../src/infrastructure/activity/activity-coordinator.ts'
import { resolveOptionalEvmPrivateHistoryAddress } from '../../../src/background/activity.ts'
import { recoverRheaWithdrawActivity } from '../../../src/background/rhea-swap.ts'
import { bindRheaSwapTransactionGraph } from '../../../src/core/transactions/domain/index.ts'
import { filterActivityItems } from '../../../src/popup/services/activity-list-model.ts'
import {
  getActivityDetailTitle,
  getActivityRouteTitle,
  getActivitySwapPresentation
} from '../../../src/popup/services/multichain-activity-presentation.ts'

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

test('recovers a submitted cross-chain Withdraw from its exact saved quote for Incognito Activity', async () => {
  const source = graph('transaction:withdraw', privateAddress, `0x${'3'.repeat(40)}`)
  const destinationChain = 'eip155:42161'
  const transactionHash = `0x${'a'.repeat(64)}`
  const binding = {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    userAction: 'transfer',
    quoteHandle: 'rhea-quote:withdraw',
    executionId: 'execution:withdraw',
    router: 'near-intents',
    sourceTarget: source.root.intent.recipient.address,
    sender: privateAddress,
    originAmountRaw: '100',
    expiresAt: 2_000,
    isCrossChain: true,
    origin: {
      chainId,
      assetId: `${chainId}/slip44:60`,
      protocolChainId: '1',
      protocolAssetId: 'nep141:eth.omft.near'
    },
    destination: {
      chainId: destinationChain,
      assetId: `${destinationChain}/slip44:60`,
      protocolChainId: '42161',
      protocolAssetId: 'nep141:arb.omft.near',
      recipient: main,
      expectedAmountRaw: '90',
      minimumAmountRaw: '80'
    }
  }
  const prepared = bindRheaSwapTransactionGraph({
    graph: source,
    binding,
    segmentIds: {
      relay: 'segment:withdraw:relay',
      destination: 'segment:withdraw:destination',
      refund: 'segment:withdraw:refund'
    },
    now: 1_000
  })
  const submitted = {
    root: { ...prepared.root, status: 'broadcast' },
    segments: [
      { ...prepared.segments[0], status: 'broadcast', evidence: { transactionHash } },
      ...prepared.segments.slice(1)
    ]
  }
  const quoteScope = {
    walletId: scope.keyDomainId,
    accountId: scope.accountId,
    purpose: 'private-cross-chain-withdraw'
  }
  const quote = {
    quoteHandle: binding.quoteHandle,
    privateSwapScope: quoteScope,
    build: { executionId: binding.executionId },
    submission: { sourceHash: transactionHash },
    request: {
      confidentiality: 'basic',
      fromChain: '1',
      toChain: '42161',
      tokenIn: { chain: '1', address: binding.origin.protocolAssetId, isNative: true },
      tokenOut: { chain: '42161', address: `0x${'0'.repeat(40)}`, isNative: true },
      sender: privateAddress,
      recipient: main,
      amountIn: '100'
    }
  }
  const marked = {
    ...submitted,
    root: {
      ...submitted.root,
      intent: { ...submitted.root.intent, protocol: { ...binding, balanceTransfer: 'withdraw' } }
    }
  }
  const repository = {
    async backfillRheaWithdrawActivity(storedScope, id, handle, execution, hash) {
      assert.deepEqual(
        [storedScope, id, handle, execution, hash],
        [scope, submitted.root.id, binding.quoteHandle, binding.executionId, transactionHash]
      )
      return marked
    }
  }
  for (const mismatch of [
    null,
    { ...quote, privateSwapScope: { ...quoteScope, purpose: 'private-cross-chain-send' } },
    { ...quote, privateSwapScope: { ...quoteScope, accountId: otherScope.accountId } },
    { ...quote, request: { ...quote.request, recipient: privateAddress } },
    { ...quote, submission: { sourceHash: `0x${'b'.repeat(64)}` } }
  ]) {
    assert.equal(
      await recoverRheaWithdrawActivity(submitted, { get: async () => mismatch }, repository),
      submitted
    )
  }
  const recovered = await recoverRheaWithdrawActivity(
    submitted,
    { get: async () => quote },
    repository
  )
  const { items } = buildActivityReadModel({ scope, localGraphs: [recovered] })
  const filter = { items, selectedChainIds: [chainId, destinationChain] }
  assert.deepEqual(filterActivityItems({ ...filter, domain: 'public' }), [])
  const [item] = filterActivityItems({ ...filter, domain: 'private' })
  assert.equal(item.accountMode, 'private')
  assert.equal(item.status, 'broadcast')
  const route = getActivitySwapPresentation(item, new Map(), new Map())
  assert.equal(route.sourceAccountMode, 'Confidential')
  assert.equal(route.destinationAccountMode, 'Public')
  assert.equal(getActivityRouteTitle(item, route, { viewedDomain: 'private' }), 'Withdraw')
  assert.equal(getActivityDetailTitle(item), 'Withdraw')
})

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

test('Private history address lookup failure leaves Public history available', async () => {
  const deriveAddress = async () => {
    throw new Error('Private address unavailable')
  }
  assert.equal(
    await resolveOptionalEvmPrivateHistoryAddress({
      includePrivate: true,
      privateAvailable: true,
      hasUnlockSession: async () => true,
      deriveAddress
    }),
    null
  )
  assert.equal(
    await resolveOptionalEvmPrivateHistoryAddress({
      includePrivate: true,
      privateAvailable: true,
      hasUnlockSession: async () => {
        throw new Error('Private session unavailable')
      },
      deriveAddress
    }),
    null
  )
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
