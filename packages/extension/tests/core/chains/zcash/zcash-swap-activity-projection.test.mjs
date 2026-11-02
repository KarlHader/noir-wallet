import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapZcashV1TransactionToActivityItem } from '../../../../src/infrastructure/activity/zcash-v1-activity-source.ts'
import {
  getActivityProgressSteps,
  getActivitySwapPresentation
} from '../../../../src/popup/components/transaction/multichain-activity-presentation.ts'

const destinationAsset = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const transaction = {
  id: 'zcash-swap-pending',
  txHash: 'ab'.repeat(32),
  status: 'confirming',
  type: 'swap',
  amount: '3.83',
  to: 'u1source-deposit',
  from: 'u1sender',
  fromType: 'shielded',
  fee: '0.0001',
  timestamp: 1000,
  network: 'mainnet',
  quoteBinding: {
    destinationAsset,
    destinationChain: 'Arbitrum',
    expectedAmountOut: '4483300000',
    recipient: '0x1234567890123456789012345678901234567890',
    depositAddress: 'u1source-deposit'
  }
}
const scope = { keyDomainId: 'wallet:activity', accountId: 'account:activity' }

test('pending ZEC swap Activity projects the quote-time final recipient and destination progress', () => {
  const item = mapZcashV1TransactionToActivityItem(transaction, scope)
  assert.deepEqual(item.snapshot.recipient, {
    chainId: 'eip155:42161',
    address: transaction.quoteBinding.recipient
  })
  assert.notEqual(item.snapshot.recipient.address, transaction.to)
  assert.deepEqual(item.snapshot.counterAmount, {
    assetId: destinationAsset,
    amountRaw: '4483300000'
  })
  const destination = item.segments.find(segment => segment.role === 'destination')
  assert.deepEqual(destination.target, { kind: 'onchain', chainId: 'eip155:42161' })
  assert.equal(destination.status, 'created')
  assert.equal(destination.evidence, undefined)

  const assetMetadata = new Map([
    [destinationAsset, { metadata: { symbol: 'USDC', decimals: 6 } }],
    ['zcash:mainnet/slip44:133', { metadata: { symbol: 'ZEC', decimals: 8 } }]
  ])
  const chainMetadata = new Map([
    ['eip155:42161', { displayName: 'Arbitrum', iconAlias: 'arbitrum' }],
    ['zcash:mainnet', { displayName: 'Zcash', iconAlias: 'zcash' }]
  ])
  const presentation = getActivitySwapPresentation(item, assetMetadata, chainMetadata)
  assert.equal(presentation.recipientAddress, transaction.quoteBinding.recipient)
  assert.equal(presentation.destination?.formatted, '4,483.3')
  assert.equal(presentation.destinationNetwork, 'Arbitrum')
  assert.equal(
    getActivityProgressSteps(item, id => chainMetadata.get(id)?.displayName ?? id).length,
    3
  )
})

test('a source deposit alone is never presented as the final recipient', () => {
  const item = mapZcashV1TransactionToActivityItem(
    { ...transaction, quoteBinding: { ...transaction.quoteBinding, recipient: undefined } },
    scope
  )
  assert.equal(item.snapshot.recipient, undefined)
  assert.equal(getActivitySwapPresentation(item, new Map(), new Map()).recipientAddress, undefined)
})
