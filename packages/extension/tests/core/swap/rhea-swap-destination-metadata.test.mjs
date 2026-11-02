import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createRheaSwapSignedOrderGraph,
  parseRheaSwapTransactionBinding,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'
import {
  createStoredTransactionGraphRecord,
  parseStoredTransactionGraphRecord
} from '../../../src/infrastructure/persistence/repositories/indexed-db-transaction-database.ts'
import { createRheaSwapBinding } from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import { resolveActivityDisplayAmount } from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'

const sourceAssetId = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const destinationAssetId = 'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'

function quoteBinding(
  tokenOut = { rheaChainId: '56', assetId: 'bsc-usdc', symbol: 'USDC', decimals: 18 }
) {
  return createRheaSwapBinding({
    source: {
      family: 'evm',
      refundAddress: sender,
      chain: { chain: { id: 'eip155:42161' } },
      asset: { asset: { id: sourceAssetId } }
    },
    destinationChainId: 'eip155:56',
    destinationAssetId,
    tokenIn: { rheaChainId: '42161', assetId: 'arb-usdc' },
    tokenOut,
    quote: {
      quoteHandle: 'quote-1',
      recipient,
      estimatedOut: '1234500000000000000',
      minAmountOut: '1200000000000000000',
      receivedAt: 1000,
      expiresAt: 5000
    },
    review: {
      executionId: 'execution-1',
      router: 'router-1',
      amountIn: '1000000',
      isCrossChain: true,
      execution: { kind: 'evm-signature', target: 'router-1' }
    }
  })
}

function signedOrder(binding) {
  return createRheaSwapSignedOrderGraph({
    transactionId: parseTransactionId('tx:rhea:destination-metadata'),
    scope: { keyDomainId: 'wallet:metadata', accountId: 'account:metadata' },
    binding,
    orderId: 'order-1',
    segmentIds: {
      origin: parseTransactionSegmentId('segment:rhea:origin:metadata'),
      relay: parseTransactionSegmentId('segment:rhea:relay:metadata'),
      destination: parseTransactionSegmentId('segment:rhea:destination:metadata'),
      refund: parseTransactionSegmentId('segment:rhea:refund:metadata')
    },
    now: 2000
  })
}

test('RHEA destination quote metadata survives binding and graph recovery for Activity', () => {
  const binding = quoteBinding()
  assert.deepEqual(binding.destination.metadata, { name: 'USDC', symbol: 'USDC', decimals: 18 })
  const recovered = parseStoredTransactionGraphRecord(
    structuredClone(createStoredTransactionGraphRecord(signedOrder(binding)))
  ).graph
  assert.deepEqual(
    recovered.root.intent.protocol.destination.metadata,
    binding.destination.metadata
  )
  assert.deepEqual(recovered.root.intent.counterAmount.metadata, binding.destination.metadata)
  assert.deepEqual(resolveActivityDisplayAmount(recovered.root.intent.counterAmount, new Map()), {
    assetId: destinationAssetId,
    symbol: 'USDC',
    formatted: '1.2345'
  })
})

test('legacy RHEA bindings and graphs remain valid without destination metadata', () => {
  const binding = quoteBinding()
  const { metadata: _metadata, ...destination } = binding.destination
  const legacy = parseRheaSwapTransactionBinding({ ...binding, destination })
  const recovered = parseStoredTransactionGraphRecord(
    structuredClone(createStoredTransactionGraphRecord(signedOrder(legacy)))
  ).graph
  assert.equal(recovered.root.intent.protocol.destination.metadata, undefined)
  assert.equal(recovered.root.intent.counterAmount.metadata, undefined)
  assert.equal(
    resolveActivityDisplayAmount(recovered.root.intent.counterAmount, new Map()),
    undefined
  )
})

test('RHEA binding rejects invalid destination metadata', () => {
  const binding = quoteBinding()
  for (const metadata of [
    { name: 'USDC', symbol: 'USDC', decimals: -1 },
    { name: 'USDC', symbol: ' USDC', decimals: 18 },
    { name: 'USDC', symbol: 'USDC', decimals: 18, extra: true }
  ]) {
    assert.throws(() =>
      parseRheaSwapTransactionBinding({
        ...binding,
        destination: { ...binding.destination, metadata }
      })
    )
  }
})

test('catalog labels outside wallet display limits do not block a RHEA quote', () => {
  const binding = quoteBinding({
    rheaChainId: '56',
    assetId: 'bsc-usdc',
    symbol: 'S'.repeat(33),
    decimals: 18
  })
  assert.equal(binding.destination.metadata, undefined)
})
