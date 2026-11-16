import assert from 'node:assert/strict'
import { it } from 'node:test'
import { selectWalletOwnedQuoteAssetExecution } from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import { resolveSwapMaximumAdjustment } from '../../../src/popup/services/swap-maximum.ts'
import {
  buildLiveSwapQuoteRequest,
  hasSwapQuoteTermsChanged,
  isAcceptedSwapReview,
  resolveScopedSwapZcashRecipient,
  resolveShieldDomainZecFundingSource,
  shieldConfidentialSwapActive
} from '../../../src/popup/services/swap-page-model.ts'
import {
  buildShieldSwapZecSourceOptions,
  SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID,
  SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
} from '../../../src/popup/services/shield-swap-zec-sources.ts'
import {
  getRheaSwapErrorMessage,
  getRheaSwapQuoteFailure,
  RheaSwapClientError
} from '../../../src/popup/services/rhea-swap-client.ts'
import { getSwapQuoteFailureMessage } from '../../../src/popup/services/swap-quote-error-message.ts'
import {
  getRheaSwapMinimumAmountMessage,
  getSafeRheaSwapRuntimeErrorMessage
} from '../../../src/core/services/rhea-swap/rhea-swap-error.ts'
import { createRheaSwapFetch } from '../../../src/core/services/rhea-swap/rhea-swap-fetch.ts'
import { classifyError } from '../../../src/lib/errors.ts'
import { selectSwapFeeEstimate } from '../../../src/lib/swap-fee.ts'
import {
  buildPublicPrivateSendPreviewRequest,
  createPublicPrivateSendPreviewKey,
  getPublicPrivateSendRouteCost
} from '../../../src/popup/services/public-private-send-preview.ts'

it('rejects a stale Zcash Max fee when a refreshed Max amount differs', () => {
  const feeQuote = { id: 'quote-1', standardMarginalFeeZats: 5000, expiresAt: 2000 }
  const max = { feeZats: 15000, feeQuote, loading: false, error: false }
  const amount = { feeZats: 10000, feeQuote, loading: false, error: false }
  assert.deepEqual(selectSwapFeeEstimate('0.9', true, '0.8', max, amount, 1000), {
    feeZats: null,
    feeQuote: null,
    ready: false,
    staleMax: true
  })
  assert.equal(selectSwapFeeEstimate('0.8', true, '0.8', max, amount, 1000).ready, true)
  assert.equal(selectSwapFeeEstimate('0.8', true, '0.8', max, amount, 2000).ready, false)
})

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
    recipientAddress: `0x${'2'.repeat(40)}`,
    confidentiality: 'basic',
    blocked: false
  }
  const quote = buildLiveSwapQuoteRequest(input)
  assert.equal(quote.request.amountIn, '500000')
  assert.equal(quote.request.sender, 'sender')
  assert.equal(quote.request.recipient, input.recipientAddress)
  const changedRecipient = buildLiveSwapQuoteRequest({
    ...input,
    recipientAddress: `0x${'6'.repeat(40)}`
  })
  assert.equal(changedRecipient.request.recipient, `0x${'6'.repeat(40)}`)
  assert.notEqual(changedRecipient.key, quote.key)
  assert.notEqual(changedRecipient.scopeKey, quote.scopeKey)
  assert.equal(
    buildLiveSwapQuoteRequest({ ...input, privateRecipientAddress: 'different-private-address' }),
    null
  )
  assert.equal(quote.request.confidentiality, 'basic')
  assert.equal(quote.request.slippageBps, 100)
  const fastQuote = buildLiveSwapQuoteRequest({ ...input, quoteMode: 'fast' })
  assert.equal(fastQuote.request.quoteMode, 'fast')
  assert.notEqual(fastQuote.key, quote.key)
  assert.notEqual(fastQuote.scopeKey, quote.scopeKey)
  const changedToken = buildLiveSwapQuoteRequest({
    ...input,
    tokenOut: { ...input.tokenOut, rheaAddress: 'different-usdc', decimals: 5 }
  })
  assert.notEqual(changedToken.key, quote.key)
  assert.notEqual(changedToken.scopeKey, quote.scopeKey)
  const zcashSource = {
    ...input,
    tokenIn: {
      ...token,
      assetId: 'zec',
      rheaChainId: 'zcash',
      rheaAddress: 'nep141:zec.omft.near',
      symbol: 'ZEC',
      decimals: 8
    },
    refundAddress: 't1source',
    zcashFundingSource: 'transparent'
  }
  const transparentZec = buildLiveSwapQuoteRequest(zcashSource)
  const shieldedZec = buildLiveSwapQuoteRequest({
    ...zcashSource,
    zcashFundingSource: 'shielded'
  })
  assert.notEqual(shieldedZec.key, transparentZec.key)
  assert.notEqual(shieldedZec.scopeKey, transparentZec.scopeKey)
  assert.deepEqual(shieldedZec.request, transparentZec.request)
  assert.equal(buildLiveSwapQuoteRequest({ ...input, amountIn: '0.0000001' }), null)
  assert.equal(buildLiveSwapQuoteRequest({ ...input, amountIn: '0.5000001' }), null)
  assert.equal(buildLiveSwapQuoteRequest({ ...input, amountIn: '0.000001' }).request.amountIn, '1')
})

it('requires a fresh, matching and explicitly accepted swap review before execution', () => {
  const now = 10_000
  const quote = {
    quoteHandle: 'quote-a',
    recipient: 'recipient',
    estimatedOut: '100',
    minAmountOut: '90',
    router: 'router',
    receivedAt: now,
    expiresAt: now + 60_000
  }
  const input = {
    quote,
    review: { ...quote, executionId: 'execution-a' },
    acceptedHandle: 'quote-a',
    quoteKey: 'request-a',
    requestKey: 'request-a',
    now
  }
  assert.equal(isAcceptedSwapReview(input), true)
  assert.equal(isAcceptedSwapReview({ ...input, acceptedHandle: null }), false)
  assert.equal(
    isAcceptedSwapReview({ ...input, review: { ...input.review, quoteHandle: 'quote-old' } }),
    false
  )
  assert.equal(isAcceptedSwapReview({ ...input, requestKey: 'request-b' }), false)
  assert.equal(isAcceptedSwapReview({ ...input, now: now + 60_000 }), false)
  assert.equal(hasSwapQuoteTermsChanged(quote, { ...quote, quoteHandle: 'quote-b' }), false)
  assert.equal(hasSwapQuoteTermsChanged(quote, { ...quote, minAmountOut: '89' }), true)
  assert.equal(hasSwapQuoteTermsChanged(quote, { ...quote, recipient: 'other' }), true)
})

it('binds the Public to Private preview to its account, quote inputs and fee context', () => {
  const token = {
    assetId: 'eip155:56/native',
    rheaChainId: '56',
    rheaAddress: 'native',
    blockchain: 'bsc',
    symbol: 'BNB',
    decimals: 6,
    isNative: true,
    sources: ['nearIntents']
  }
  const input = {
    network: 'mainnet',
    walletId: 'wallet-a',
    accountId: 'account-a',
    endpointKey: 'rpc-a',
    portfolioWalletId: 'wallet-a',
    portfolioAccountId: 'account-a',
    assetId: token.assetId,
    assetReference: 'native',
    assetDecimals: 6,
    chainId: 'eip155:56',
    sender: `0x${'1'.repeat(40)}`,
    recipient: `0x${'2'.repeat(40)}`,
    amount: '0.5',
    amountRaw: '500000',
    slippage: 1,
    feeSelectionKey: 'standard',
    sourceToken: token,
    destinationToken: token
  }
  const preview = buildPublicPrivateSendPreviewRequest(input)
  assert.equal(preview.key, createPublicPrivateSendPreviewKey(input))
  assert.equal(preview.request.confidentiality, 'basic')
  assert.equal(preview.request.amountIn, '500000')
  for (const changed of [
    { walletId: 'wallet-b' },
    { accountId: 'account-b' },
    { portfolioWalletId: 'wallet-b' },
    { endpointKey: 'rpc-b' },
    { assetReference: 'another-asset' },
    { assetDecimals: 18 },
    { chainId: 'eip155:1' },
    { recipient: `0x${'3'.repeat(40)}` },
    { amount: '0.6', amountRaw: '600000' },
    { slippage: 2 },
    { feeSelectionKey: 'fast' }
  ]) {
    assert.notEqual(createPublicPrivateSendPreviewKey({ ...input, ...changed }), preview.key)
  }
  assert.equal(buildPublicPrivateSendPreviewRequest({ ...input, network: 'testnet' }), null)
  assert.equal(
    buildPublicPrivateSendPreviewRequest({
      ...input,
      destinationToken: { ...token, decimals: 18 }
    }),
    null
  )
  assert.equal(
    getPublicPrivateSendRouteCost({
      amountInRaw: '500000',
      estimatedOutRaw: '490000',
      decimals: 6
    }),
    '0.01'
  )
  assert.equal(
    getPublicPrivateSendRouteCost({
      amountInRaw: '500000',
      estimatedOutRaw: '510000',
      decimals: 6
    }),
    null
  )
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
    getSwapQuoteFailureMessage(
      new Error(
        'No confidential route available: quote failed (400): {"msg":"transport timeout","reason":"quote_timeout"}'
      )
    ),
    'Request timed out.'
  )
  assert.equal(
    getSwapQuoteFailureMessage(new Error('Temporary swap limits: minimum swap amount is $1,000')),
    'Minimum swap amount is $1,000.'
  )
  assert.equal(getSwapQuoteFailureMessage(new Error('No route found')), 'no route')
  assert.deepEqual(getRheaSwapQuoteFailure(new RheaSwapClientError('No route found')), {
    message: 'no route',
    retryable: false
  })
  assert.deepEqual(getRheaSwapQuoteFailure(new RheaSwapClientError('quote_timeout')), {
    message: 'no route',
    retryable: true
  })
  assert.deepEqual(getRheaSwapQuoteFailure(new RheaSwapClientError('fetch failed')), {
    message: 'Network error. Please check your internet connection.',
    retryable: true
  })
  assert.equal(getSwapQuoteFailureMessage(new Error('Shield balance is insufficient')), null)
  assert.equal(getSwapQuoteFailureMessage(new Error('Confidential quote has expired')), null)
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('{"message":"Request timed out","path":"/internal"}')
    ),
    'Request timed out.'
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
    'Request timed out.'
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
    'Request timed out.'
  )
  assert.equal(
    getRheaSwapErrorMessage(
      new RheaSwapClientError(
        'Cross-chain quote failed: {"code":-1,"errorCode":"QUOTE_TIMEOUT","reason":"quote_timeout","msg":"Cross-chain quote failed: nearintents: quote transport timeout after 6s; preswap: pre-swap route does not yet support fromChain=zcash","retryAfterMs":6500}'
      )
    ),
    'Request timed out.'
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

it('keeps a quote timeout retryable when a successful HTTP response also mentions an unsupported route', async () => {
  const fetchQuote = createRheaSwapFetch(
    async () =>
      new Response(
        JSON.stringify({
          code: -1,
          errorCode: 'QUOTE_TIMEOUT',
          reason: 'quote_timeout',
          msg: 'Cross-chain quote failed: nearintents: quote transport timeout after 6s; preswap: pre-swap route does not yet support fromChain=zcash',
          retryAfterMs: 6500
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )
  await assert.rejects(fetchQuote('https://api.rhea.finance/api/swap/quote'), error => {
    assert.equal(error.code, 'REQUEST_TIMEOUT')
    const runtimeMessage = getSafeRheaSwapRuntimeErrorMessage(error)
    assert.equal(runtimeMessage, 'quote_timeout')
    const popupError = new RheaSwapClientError(runtimeMessage)
    assert.equal(getRheaSwapErrorMessage(popupError), 'Request timed out.')
    assert.equal(classifyError(popupError).retryable, true)
    return true
  })
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
  const bridgeFailure =
    'No confidential route available: Cross-chain quote failed: nearintents: NearIntents quote failed (400): {"message":"Amount is too low for bridge, try at least 133602","correlationId":"provider-reference","timestamp":"2026-11-09T15:49:49Z","path":"/v0/quote"}'
  const bridgeMessage = 'Amount is below the route minimum. Increase the amount and try again.'
  const safeBridgeMessage = getSafeRheaSwapRuntimeErrorMessage(new Error(bridgeFailure))
  assert.equal(safeBridgeMessage, bridgeMessage)
  assert.equal(getRheaSwapErrorMessage(new RheaSwapClientError(bridgeFailure)), bridgeMessage)
  assert.equal(getRheaSwapErrorMessage(new RheaSwapClientError(safeBridgeMessage)), bridgeMessage)
  assert.equal(classifyError(new RheaSwapClientError(safeBridgeMessage)).retryable, false)
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
    'Request timed out.'
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

it('keeps Shield native ZEC swap on shielded funding without merging confidential balances', () => {
  assert.equal(
    resolveShieldDomainZecFundingSource({
      ordinarySwapRequested: true,
      shieldZecSource: 'native-shielded',
      isZecSource: true,
      selectedFundingSource: 'transparent'
    }),
    'shielded'
  )
  assert.equal(
    resolveShieldDomainZecFundingSource({
      ordinarySwapRequested: true,
      shieldZecSource: 'intents',
      isZecSource: true,
      selectedFundingSource: 'transparent'
    }),
    'transparent'
  )
  assert.equal(
    shieldConfidentialSwapActive({ shieldSwapSelected: true, shieldZecSource: 'native-shielded' }),
    false
  )
  assert.equal(
    shieldConfidentialSwapActive({ shieldSwapSelected: true, shieldZecSource: 'intents' }),
    true
  )
})

it('lists Intents and native Shield ZEC as separate selectable sources with distinct balances', () => {
  const previousFlags = globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash']
  try {
    const input = {
      network: 'mainnet',
      sources: [
        {
          asset: {
            asset: { id: 'wallet-zec-intents', chainId: 'near:mainnet', kind: 'token' },
            metadata: { symbol: 'ZEC', decimals: 8, name: 'ZEC' },
            balance: { totalRaw: '0' }
          },
          chain: { chain: { id: 'near:mainnet', family: 'near', displayName: 'NEAR' } },
          managed: { protocolAssetId: 'nep141:zec.omft.near', assetId: 'wallet-zec-intents' }
        }
      ],
      balances: [{ tokenId: 'nep141:zec.omft.near', available: '120000000' }],
      portfolio: {
        assets: [
          {
            asset: {
              id: 'zcash:zec:mainnet:native',
              chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
              kind: 'native'
            },
            metadata: { symbol: 'ZEC', decimals: 8, name: 'ZEC' },
            balance: {
              totalRaw: '50000000',
              transparentRaw: '0',
              shieldedRaw: '50000000',
              shieldedPendingRaw: '10000000'
            }
          }
        ],
        chains: []
      },
      enabledFlags: ['chain.zcash'],
      zcashAccountEnabled: true,
      keySource: 'software'
    }
    const options = buildShieldSwapZecSourceOptions(input)
    assert.equal(options.length, 2)
    assert.equal(options[0].selectionId, SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID)
    assert.equal(options[0].availableRaw, '120000000')
    assert.equal(options[0].badgeBlockchain, 'zec')
    assert.equal(options[1].selectionId, SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID)
    assert.equal(options[1].availableRaw, '40000000')
    assert.equal(options[1].badgeBlockchain, 'zec')
    const pendingOnly = buildShieldSwapZecSourceOptions({
      ...input,
      portfolio: {
        ...input.portfolio,
        assets: input.portfolio.assets.map(asset => ({
          ...asset,
          balance: { ...asset.balance, shieldedPendingRaw: asset.balance.shieldedRaw }
        }))
      }
    })
    assert.equal(pendingOnly[1].availableRaw, '0')
  } finally {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = previousFlags
  }
})
