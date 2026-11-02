import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQuoteDepositTransferClient } from '../../../../src/popup/services/quote-deposit-transfer-client.ts'
import { resolveSwapMaximumAdjustment } from '../../../../src/popup/services/swap-maximum.ts'

test('native RHEA Max keeps fee headroom and accepts a quote after a small fee increase', async () => {
  const balanceRaw = 1_000_000_000_000_000_000n
  const initialFeeRaw = 100_000_000_000_000n
  const laterFeeRaw = initialFeeRaw + 43_863_666_000n
  const attachedValueRaw = 1_000_000_000_000n
  let currentFeeRaw = initialFeeRaw
  const source = {
    family: 'evm',
    chain: { chain: { id: 'eip155:1' } },
    asset: {
      asset: { id: 'eip155:1/slip44:60', kind: 'native' },
      metadata: { decimals: 18 },
      balance: { availableRaw: balanceRaw.toString() }
    },
    networkFeeAsset: { metadata: { symbol: 'ETH', decimals: 18 } }
  }
  const transfer = createQuoteDepositTransferClient({
    evm: {
      prepareContractCall: async intent => {
        assert.ok(BigInt(intent.valueRaw) + currentFeeRaw <= balanceRaw)
        return {
          graph: { root: { id: 'fee-probe' } },
          review: {
            summary: {
              schema: 'evm.transaction.v1',
              fields: { maximumFeeWei: currentFeeRaw.toString() }
            }
          }
        }
      },
      rejectTransfer: async () => {}
    }
  })
  const firstQuoteRaw = balanceRaw / 2n
  const plan = amountRaw => ({
    chainId: 1,
    to: '0x2222222222222222222222222222222222222222',
    data: '0x1234',
    value: (amountRaw + attachedValueRaw).toString()
  })
  const maximum = await transfer.estimateMaximum({
    source,
    depositAddress: plan(firstQuoteRaw).to,
    evmTransaction: plan(firstQuoteRaw),
    quotedAmountRaw: firstQuoteRaw.toString(),
    feeTier: 'standard'
  })
  const expectedRaw = balanceRaw - initialFeeRaw - initialFeeRaw / 4n - attachedValueRaw
  assert.equal(maximum.amountRaw, expectedRaw.toString())
  assert.equal(maximum.networkFeeRaw, initialFeeRaw.toString())

  const dependencies = {
    getEvmTransactionPlan: async quoteHandle => ({
      approval: null,
      transaction: plan(BigInt(quoteHandle))
    }),
    estimateMaximum: transfer.estimateMaximum
  }
  const fullQuote = await resolveSwapMaximumAdjustment(
    {
      source,
      review: {
        amountIn: balanceRaw.toString(),
        quoteHandle: balanceRaw.toString(),
        execution: { kind: 'evm-transaction', target: plan(balanceRaw).to }
      },
      currentAmount: '1',
      feeTier: 'standard',
      executionMode: 'main',
      refreshFees: false,
      adjustmentCount: 0
    },
    dependencies
  )
  assert.deepEqual(fullQuote, { amount: '0.5', adjustmentCount: 0 })
  const bufferedQuote = await resolveSwapMaximumAdjustment(
    {
      source,
      review: {
        amountIn: firstQuoteRaw.toString(),
        quoteHandle: firstQuoteRaw.toString(),
        execution: { kind: 'evm-transaction', target: plan(firstQuoteRaw).to }
      },
      currentAmount: fullQuote.amount,
      feeTier: 'standard',
      executionMode: 'main',
      refreshFees: false,
      adjustmentCount: fullQuote.adjustmentCount
    },
    dependencies
  )
  assert.deepEqual(bufferedQuote, { amount: '0.999874', adjustmentCount: 1, maximum })

  currentFeeRaw = laterFeeRaw
  const adjustment = await resolveSwapMaximumAdjustment(
    {
      source,
      review: {
        amountIn: expectedRaw.toString(),
        quoteHandle: 'max-quote',
        execution: { kind: 'evm-transaction', target: plan(expectedRaw).to }
      },
      currentAmount: bufferedQuote.amount,
      feeTier: 'standard',
      executionMode: 'main',
      refreshFees: false,
      adjustmentCount: bufferedQuote.adjustmentCount
    },
    {
      ...dependencies,
      getEvmTransactionPlan: async () => ({ approval: null, transaction: plan(expectedRaw) })
    }
  )
  assert.equal(adjustment, null)
})
