import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  resolveEvmSwapMaximumInsufficientFundsAdjustment,
  resolveSwapMaximumAdjustment
} from '../../../src/popup/services/swap-maximum.ts'
import { EvmWalletClientError } from '../../../src/popup/services/evm-wallet-client.ts'
import {
  buildLiveSwapQuoteRequest,
  createSwapQuoteRefreshTarget,
  isSwapQuoteRefreshReady
} from '../../../src/popup/services/swap-page-model.ts'

function input(overrides = {}) {
  return {
    source: {
      family: 'evm',
      chain: { chain: { id: 'eip155:1' } },
      asset: {
        asset: { kind: 'native' },
        metadata: { decimals: 6 },
        balance: { availableRaw: '1000000' }
      },
      networkFeeAsset: { metadata: { symbol: 'ETH', decimals: 6 } }
    },
    review: {
      quoteHandle: 'quote-1',
      amountIn: '500000',
      execution: { kind: 'evm-transaction', target: '0xcontract' }
    },
    currentAmount: '0.5',
    feeTier: 'standard',
    executionMode: 'main',
    refreshFees: false,
    adjustmentCount: 0,
    ...overrides
  }
}

test('quotes a smaller real native amount before estimating Max or a changed fee tier', async () => {
  const unexpected = async () => {
    throw new Error('must re-quote before estimating the call')
  }
  const dependencies = { getEvmTransactionPlan: unexpected, estimateMaximum: unexpected }
  const full = input({ currentAmount: '1' })
  full.review.amountIn = '1000000'
  await expect(resolveSwapMaximumAdjustment(full, dependencies)).resolves.toEqual({
    amount: '0.5',
    adjustmentCount: 0
  })
  await expect(
    resolveSwapMaximumAdjustment(input({ refreshFees: true }), dependencies)
  ).resolves.toEqual({ amount: '0.25', adjustmentCount: 0 })
})

test('uses the half-balance fee probe to reach a buffered near-full Max', async () => {
  const source = input().source
  const prepare = amountRaw => ({
    quoteHandle: amountRaw,
    amountIn: amountRaw,
    execution: { kind: 'evm-transaction', target: '0xcontract' }
  })
  const dependencies = {
    getEvmTransactionPlan: async () => ({ approval: null, transaction: {} }),
    estimateMaximum: async () => ({ amountRaw: '875000', networkFeeRaw: '100000' })
  }
  const full = input({ source, currentAmount: '1', review: prepare('1000000') })
  const probe = await resolveSwapMaximumAdjustment(full, dependencies)
  expect(probe).toEqual({ amount: '0.5', adjustmentCount: 0 })

  const nearFull = await resolveSwapMaximumAdjustment(
    input({ source, currentAmount: probe.amount, review: prepare('500000'), adjustmentCount: 0 }),
    dependencies
  )
  expect(nearFull).toEqual({
    amount: '0.875',
    adjustmentCount: 1,
    maximum: { amountRaw: '875000', networkFeeRaw: '100000' }
  })
  await expect(
    resolveSwapMaximumAdjustment(
      input({
        source,
        currentAmount: nearFull.amount,
        review: prepare('875000'),
        adjustmentCount: 1
      }),
      dependencies
    )
  ).resolves.toBeNull()
})

test('fee-tier refresh restarts an existing Max adjustment at the fee probe', async () => {
  const dependencies = {
    getEvmTransactionPlan: async () => ({ approval: null, transaction: {} }),
    estimateMaximum: async () => ({ amountRaw: '825000', networkFeeRaw: '140000' })
  }
  for (const previousAdjustments of [1, 2]) {
    const refreshed = await resolveSwapMaximumAdjustment(
      input({
        currentAmount: '0.875',
        review: { ...input().review, amountIn: '875000' },
        refreshFees: true,
        adjustmentCount: previousAdjustments
      }),
      dependencies
    )
    expect(refreshed).toEqual({ amount: '0.5', adjustmentCount: 0 })
    await expect(
      resolveSwapMaximumAdjustment(
        input({
          currentAmount: refreshed.amount,
          review: { ...input().review, amountIn: '500000' },
          feeTier: 'fast',
          adjustmentCount: refreshed.adjustmentCount
        }),
        dependencies
      )
    ).resolves.toEqual({
      amount: '0.825',
      adjustmentCount: 1,
      maximum: { amountRaw: '825000', networkFeeRaw: '140000' }
    })
  }
})

test('uses the authoritative native contract plan and only adjusts an unaffordable quote', async () => {
  const calls = []
  const transaction = { chainId: 1, to: '0xcontract', data: '0x1234', value: '999990', from: null }
  const dependencies = {
    getEvmTransactionPlan: async handle => {
      calls.push(handle)
      return { transaction, approval: null }
    },
    estimateMaximum: async request => {
      calls.push(request)
      return { amountRaw: '999937', networkFeeRaw: '50' }
    }
  }
  const review = {
    quoteHandle: 'quote-1',
    amountIn: '999990',
    execution: { kind: 'evm-transaction', target: '0xcontract' }
  }
  const request = input({ executionMode: 'private', currentAmount: '0.99999', review })
  await expect(resolveSwapMaximumAdjustment(request, dependencies)).resolves.toEqual({
    amount: '0.999937',
    adjustmentCount: 1,
    maximum: { amountRaw: '999937', networkFeeRaw: '50' }
  })
  expect(calls[1]).toMatchObject({
    evmTransaction: transaction,
    quotedAmountRaw: '999990',
    executionMode: 'private'
  })
  await expect(
    resolveSwapMaximumAdjustment(
      input({
        currentAmount: '0.999937',
        adjustmentCount: 1,
        review: { ...review, amountIn: '999937' }
      }),
      dependencies
    )
  ).resolves.toBeNull()
  await expect(
    resolveSwapMaximumAdjustment(input({ ...request, adjustmentCount: 4 }), dependencies)
  ).rejects.toThrow('maximum spendable')
})

test('accepts the buffered native quote when a later fee increases by less than the headroom', async () => {
  const amounts = ['850000', '841000', '890000']
  const fees = ['100000', '110000', '80000']
  const dependencies = {
    getEvmTransactionPlan: async () => ({ approval: null, transaction: {} }),
    estimateMaximum: async () => ({
      amountRaw: amounts.shift(),
      networkFeeRaw: fees.shift()
    })
  }
  const initial = input({
    currentAmount: '0.9',
    review: { ...input().review, amountIn: '900000' }
  })
  await expect(resolveSwapMaximumAdjustment(initial, dependencies)).resolves.toEqual({
    amount: '0.85',
    adjustmentCount: 1,
    maximum: { amountRaw: '850000', networkFeeRaw: '100000' }
  })
  const buffered = input({
    currentAmount: '0.85',
    adjustmentCount: 1,
    review: { ...input().review, amountIn: '850000' }
  })
  await expect(resolveSwapMaximumAdjustment(buffered, dependencies)).resolves.toBeNull()
  await expect(resolveSwapMaximumAdjustment(buffered, dependencies)).resolves.toBeNull()
})

test('does not deduct native gas from a token balance or invent transaction gas for signature orders', async () => {
  const unexpected = async () => {
    throw new Error('unexpected preparation')
  }
  const dependencies = { getEvmTransactionPlan: unexpected, estimateMaximum: unexpected }
  const token = input()
  token.source.asset.asset.kind = 'erc20'
  await expect(resolveSwapMaximumAdjustment(token, dependencies)).resolves.toBeNull()
  const signature = input()
  signature.review.execution.kind = 'evm-signature'
  await expect(resolveSwapMaximumAdjustment(signature, dependencies)).resolves.toBeNull()
})

test('rejects a token approval on a native route and falls back when simulation fails', async () => {
  const dependencies = {
    getEvmTransactionPlan: async () => ({ approval: {} }),
    estimateMaximum: async () => {
      throw new Error('simulation failed')
    }
  }
  await expect(resolveSwapMaximumAdjustment(input(), dependencies)).rejects.toThrow('native Swap')
  dependencies.getEvmTransactionPlan = async () => ({ approval: null, transaction: {} })
  await expect(
    resolveSwapMaximumAdjustment(input({ currentAmount: '0.97' }), dependencies)
  ).resolves.toEqual({
    amount: '0.95',
    adjustmentCount: 1
  })
  dependencies.estimateMaximum = async () => {
    throw new Error('Invalid signing summary')
  }
  await expect(resolveSwapMaximumAdjustment(input(), dependencies)).rejects.toThrow(
    'Invalid signing summary'
  )
})

test('re-quotes a bounded smaller exact call when fee details are unavailable', async () => {
  const dependencies = {
    getEvmTransactionPlan: async () => ({ approval: null, transaction: {} }),
    estimateMaximum: async () => {
      throw new EvmWalletClientError('insufficient-funds', 'Insufficient funds')
    }
  }
  await expect(
    resolveSwapMaximumAdjustment(input({ adjustmentCount: 1 }), dependencies)
  ).resolves.toEqual({ amount: '0.375', adjustmentCount: 2 })
  await expect(
    resolveSwapMaximumAdjustment(input({ adjustmentCount: 4 }), dependencies)
  ).rejects.toThrow('maximum spendable')
})

test('re-quotes by twice the reported wei shortfall after a final EVM fee change', () => {
  const source = input().source
  source.asset.metadata.decimals = 18
  source.asset.balance.availableRaw = '1000000000000000000'
  const error = new EvmWalletClientError(
    'insufficient-funds',
    'The EVM balance is insufficient',
    '43863666000'
  )
  expect(
    resolveEvmSwapMaximumInsufficientFundsAdjustment(
      { source, currentAmount: '0.999875', adjustmentCount: 1 },
      error
    )
  ).toEqual({ amount: '0.999874912272668', adjustmentCount: 2 })
  expect(
    resolveEvmSwapMaximumInsufficientFundsAdjustment(
      { source, currentAmount: '0.999875', adjustmentCount: 1 },
      new Error('RPC failed')
    )
  ).toBeNull()
})

test('continues Max review only for the requested new quote, not an old amount or account', () => {
  const options = {
    tokenIn: { assetId: 'ETH', decimals: 18 },
    tokenOut: { assetId: 'BTC' },
    amountIn: '1',
    slippage: 1,
    refundAddress: 'sender',
    recipientAddress: 'recipient',
    blocked: false
  }
  const old = buildLiveSwapQuoteRequest(options)
  const target = createSwapQuoteRefreshTarget(old, { decimal: '0.5', decimals: 18 })
  expect(isSwapQuoteRefreshReady(target, old, old.key)).toBe(false)
  const next = buildLiveSwapQuoteRequest({ ...options, amountIn: '0.5' })
  expect(isSwapQuoteRefreshReady(target, next, old.key)).toBe(false)
  expect(isSwapQuoteRefreshReady(target, next, next.key)).toBe(true)
  const other = buildLiveSwapQuoteRequest({
    ...options,
    amountIn: '0.5',
    refundAddress: 'other-account'
  })
  expect(isSwapQuoteRefreshReady(target, other, other.key)).toBe(false)
})
