import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPrivateBalanceTransferReview } from '../../../src/popup/services/private-balance-transfer-review.ts'

const recipient = '0x8b3400000000000000000000000000000085cea1'
const contract = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const review = {
  quoteHandle: 'quote-1',
  executionId: 'execution-1',
  amountIn: '4404099793',
  estimatedOut: '4403987654',
  execution: { target: contract }
}
const binding = {
  quoteHandle: review.quoteHandle,
  executionId: review.executionId,
  originAmountRaw: review.amountIn,
  destination: { recipient, expectedAmountRaw: review.estimatedOut }
}

test('transfer review shows exact prepared amounts and the bound recipient, not the token contract', () => {
  assert.deepEqual(
    createPrivateBalanceTransferReview({
      binding,
      review,
      sourceDecimals: 6,
      destinationDecimals: 6
    }),
    {
      quoteHandle: 'quote-1',
      executionId: 'execution-1',
      amountIn: '4,404.099793',
      amountOut: '4,403.987654',
      recipient
    }
  )
})

test('transfer review rejects a quote that differs from the prepared binding', () => {
  assert.throws(
    () =>
      createPrivateBalanceTransferReview({
        binding: { ...binding, originAmountRaw: '0' },
        review,
        sourceDecimals: 6,
        destinationDecimals: 6
      }),
    /does not match/
  )
  assert.throws(
    () =>
      createPrivateBalanceTransferReview({
        binding: { ...binding, destination: { ...binding.destination, recipient: '' } },
        review,
        sourceDecimals: 6,
        destinationDecimals: 6
      }),
    /does not match/
  )
})
