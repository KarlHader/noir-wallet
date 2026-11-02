import assert from 'node:assert/strict'
import { it } from 'node:test'
import { selectWalletOwnedQuoteAssetExecution } from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import { resolveSwapMaximumAdjustment } from '../../../src/popup/services/swap-maximum.ts'
import {
  buildLiveSwapQuoteRequest,
  resolveScopedSwapZcashRecipient
} from '../../../src/popup/services/swap-page-model.ts'
import {
  getRheaSwapErrorMessage,
  RheaSwapClientError
} from '../../../src/popup/services/rhea-swap-client.ts'
import {
  getRheaSwapMinimumAmountMessage,
  getSafeRheaSwapRuntimeErrorMessage
} from '../../../src/core/services/rhea-swap/rhea-swap-error.ts'
import { classifyError } from '../../../src/lib/errors.ts'

function source(balance = '1000000') {
  return {
    family: 'evm',
    refundAddress: `0x${'1'.repeat(40)}`,
    chain: { chain: { id: 'eip155:56' } },
    asset: {
      asset: { kind: 'native' },
      metadata: { decimals: 6 },
      balance: { availableRaw: balance }
    },
    networkFeeAsset: {
      metadata: { decimals: 6, symbol: 'BNB' },
      balance: { availableRaw: balance }
    }
  }
}

it('uses Public-only balances without admitting an unpartitioned dual-source balance', () => {
  const publicSource = source()
  assert.equal(selectWalletOwnedQuoteAssetExecution(publicSource, 'main'), null)
  assert.equal(
    selectWalletOwnedQuoteAssetExecution(publicSource, 'main', undefined, true).asset.balance
      .availableRaw,
    '1000000'
  )
  assert.equal(
    selectWalletOwnedQuoteAssetExecution(source('0'), 'main', undefined, true).refundAddress,
    publicSource.refundAddress
  )
  assert.equal(selectWalletOwnedQuoteAssetExecution(publicSource, 'private', undefined, true), null)
  const split = source()
  split.asset.balance.mainRaw = '200000'
  split.networkFeeAsset.balance.mainRaw = '300000'
  const selected = selectWalletOwnedQuoteAssetExecution(split, 'main')
  assert.equal(selected.asset.balance.availableRaw, '200000')
  assert.equal(selected.networkFeeAsset.balance.availableRaw, '300000')
})

it('returns the quote-specific Max with its fee so display and validation can replace a stale estimate', async () => {
  const maximum = {
    amountRaw: '875000',
    networkFeeRaw: '100000',
    networkFeeDecimals: 6,
    networkFeeSymbol: 'BNB'
  }
  const transaction = { value: '500000', data: '0x' }
  const adjustment = await resolveSwapMaximumAdjustment(
    {
      source: source(),
      review: {
        quoteHandle: 'quote',
        amountIn: '500000',
        execution: { kind: 'evm-transaction', target: `0x${'2'.repeat(40)}` }
      },
      currentAmount: '0.5',
      feeTier: 'standard',
      executionMode: 'main',
      refreshFees: false,
      adjustmentCount: 0
    },
    {
      getEvmTransactionPlan: async () => ({ transaction }),
      estimateMaximum: async input => {
        assert.equal(input.evmTransaction, transaction)
        assert.equal(input.quotedAmountRaw, '500000')
        return maximum
      }
    }
  )
  assert.equal(adjustment.amount, '0.875')
  assert.equal(adjustment.maximum, maximum)
  assert.equal(transaction.value, '500000')
})

it('retains the reviewed sender, recipient, amount and privacy mode when a quote is refreshed', () => {
  const token = {
    assetId: 'bnb',
    rheaChainId: '56',
    rheaAddress: 'native',
    symbol: 'BNB',
    decimals: 6,
    isNative: true
  }
  const input = {
    tokenIn: token,
    tokenOut: { ...token, assetId: 'usdc', rheaAddress: 'usdc', symbol: 'USDC', isNative: false },
    amountIn: '0.5',
    slippage: 1,
    refundAddress: 'sender',
    recipientAddress: 'recipient',
    confidentiality: 'basic',
    blocked: false
  }
  const quote = buildLiveSwapQuoteRequest(input)
  assert.equal(quote.request.amountIn, '500000')
  assert.equal(quote.request.sender, 'sender')
  assert.equal(quote.request.recipient, 'recipient')
  const changedRecipient = buildLiveSwapQuoteRequest({
    ...input,
    recipientAddress: 'other-recipient'
  })
  assert.equal(changedRecipient.request.recipient, 'other-recipient')
  assert.notEqual(changedRecipient.key, quote.key)
  assert.equal(quote.request.confidentiality, 'basic')
  assert.equal(quote.request.slippageBps, 100)
  assert.equal(buildLiveSwapQuoteRequest({ ...input, amountIn: '0.0000001' }), null)
  assert.equal(buildLiveSwapQuoteRequest({ ...input, amountIn: '0.5000001' }), null)
  assert.equal(buildLiveSwapQuoteRequest({ ...input, amountIn: '0.000001' }).request.amountIn, '1')
})

it('accepts a Zcash recipient only for its selected account scope and network', () => {
  const address = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F'
  assert.deepEqual(
    resolveScopedSwapZcashRecipient({ scope: 'wallet-a', address }, 'wallet-a', 'mainnet'),
    { address, error: null }
  )
  assert.deepEqual(
    resolveScopedSwapZcashRecipient({ scope: 'wallet-a', address }, 'wallet-b', 'mainnet'),
    { address: '', error: null }
  )
  assert.equal(
    resolveScopedSwapZcashRecipient({ scope: 'wallet-a', address }, 'wallet-a', 'testnet').error,
    'Enter a valid Zcash address.'
  )
  assert.equal(
    resolveScopedSwapZcashRecipient({ scope: 'wallet-a', address: '0x123' }, 'wallet-a', 'mainnet')
      .error,
    'Enter a valid Zcash address.'
  )
})

it('keeps minimum amounts while removing nested provider metadata without changing retry classification', () => {
  const error = new RheaSwapClientError(
    'No confidential route available: quote failed (400): {"message":"Temporary swap limits: minimum swap amount is $1,000","correlationId":"test-correlation","timestamp":"2026-01-01","path":"/v0/quote"}'
  )
  const before = classifyError(error)
  assert.equal(getRheaSwapErrorMessage(error), 'Minimum swap amount is $1,000.')
  assert.deepEqual(classifyError(error), before)
  assert.equal(
    getRheaSwapErrorMessage(new RheaSwapClientError('{invalid response')),
    'An unexpected error occurred. Please try again.'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('{"message":"Request timed out","path":"/internal"}')
    ),
    'No route found for this swap.'
  )
  assert.equal(
    getRheaSwapErrorMessage(new RheaSwapClientError('Unsupported destination token')),
    'This destination is unavailable for this swap. Choose another asset.'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError(
        'No confidential route available: quote failed (400): {"msg":"transport timeout","code":"QUOTE_TIMEOUT","reason":"quote_timeout","retryAfter":6500}'
      )
    ),
    'No route found for this swap.'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError(
        'No confidential route available: quote failed (400): {"msg":"No route found","timeout":6000}'
      )
    ),
    'no route'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError(
        'No confidential route available: quote failed (400): {"msg":"No route found","error":{"reason":"quote_timeout"}}'
      )
    ),
    'No route found for this swap.'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('No confidential route available: Cross-chain quote failed')
    ),
    'no route'
  )
  assert.equal(
    getRheaSwapErrorMessage(new RheaSwapClientError('confidential_route_unavailable')),
    'no route'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('No supported route currently. Please try again.')
    ),
    'no route'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('Quote response does not contain a valid best route')
    ),
    'no route'
  )
})

it('keeps provider minimums from multiple route failures without returning provider metadata', () => {
  const providerFailure =
    'NearIntents quote failed (400): {"message":"Temporary swap limits: minimum swap amount is $1,000","correlationId":"provider-reference"}'
  const compound = `Cross-chain quote failed: nearintents: ${providerFailure}; preswap: pre-swap route failed: USDT: 1Click quote failed: ${providerFailure}`
  const error = new RheaSwapClientError(compound)
  const classification = classifyError(error)
  assert.equal(getRheaSwapErrorMessage(error), 'Minimum swap amount is $1,000.')
  assert.deepEqual(classifyError(error), classification)
  assert.equal(
    getRheaSwapMinimumAmountMessage(`${compound}${' unrelated provider detail'.repeat(30)}`),
    'Minimum swap amount is $1,000.'
  )
  const runtimeMessage = getSafeRheaSwapRuntimeErrorMessage(
    new Error(`${compound}${' unrelated provider detail'.repeat(30)}`)
  )
  assert.equal(runtimeMessage, 'Minimum swap amount is $1,000.')
  assert.equal(getRheaSwapMinimumAmountMessage(runtimeMessage), runtimeMessage)
  assert.equal(getRheaSwapErrorMessage(new RheaSwapClientError(runtimeMessage)), runtimeMessage)
  assert.equal(getSafeRheaSwapRuntimeErrorMessage(new Error(runtimeMessage)), runtimeMessage)
  assert.equal(
    getRheaSwapMinimumAmountMessage('Minimum swap amount is $1,000.125.'),
    'Minimum swap amount is $1,000.125.'
  )
  assert.equal(
    getSafeRheaSwapRuntimeErrorMessage(new Error('private_key:secret')),
    'RHEA Swap request failed'
  )
  assert.equal(
    getSafeRheaSwapRuntimeErrorMessage(new Error('Unrecognized response'.repeat(40))),
    'RHEA Swap request failed'
  )
  assert.equal(getRheaSwapMinimumAmountMessage('Request timed out'), null)
  assert.equal(getRheaSwapMinimumAmountMessage('minimum swap amount is $123456789012345'), null)
  assert.equal(getRheaSwapMinimumAmountMessage('minimum swap amount is $1,000.1234567'), null)
  assert.equal(
    getRheaSwapErrorMessage(new RheaSwapClientError('Request timed out')),
    'No route found for this swap.'
  )
})

it('identifies native gas insufficiency in Swap and Transfer without hiding unrelated failures', () => {
  for (const message of [
    'The EVM balance is insufficient',
    'The EVM balance does not cover the transfer and network fee',
    'EVM account needs 100 more wei for transaction value and maximum Gas',
    'Private Execution Address needs 100 more wei for transaction value and maximum Gas'
  ]) {
    const error = new Error(message)
    assert.equal(
      getRheaSwapErrorMessage(error),
      'Insufficient native balance for the amount and network fee.'
    )
    assert.equal(classifyError(error).retryable, false)
  }
  assert.equal(getRheaSwapErrorMessage(new Error('Request timed out')), 'Request timed out.')
})
