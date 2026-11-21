import assert from 'node:assert/strict'
import { it } from 'node:test'
import { selectWalletOwnedQuoteAssetExecution } from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import {
  canContinueCombinedSwap,
  getCombinedSwapFeeLimit
} from '../../../src/popup/services/rhea-evm-approval.ts'
import { resolveSwapMaximumAdjustment } from '../../../src/popup/services/swap-maximum.ts'
import {
  buildLiveSwapQuoteRequest,
  resolveNativeZecIntentsDestination,
  resolveScopedSwapZcashRecipient,
  resolveShieldDomainZecFundingSource,
  shieldConfidentialSwapActive
} from '../../../src/popup/services/swap-page-model.ts'
import {
  canReviewQuote,
  compareQuoteTerms,
  isQuoteReviewAccepted,
  quoteReviewActionLabel,
  stageQuoteReview
} from '../../../src/popup/services/quote-review.ts'
import {
  buildShieldSwapZecSourceOptions,
  isShieldSwapZecSelectionId,
  parseShieldSwapZecSourceParam,
  SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID,
  SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID,
  SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
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
import { RheaSwapApi } from '../../../src/core/services/rhea-swap/rhea-swap-api.ts'
import { classifyError } from '../../../src/lib/errors.ts'
import { selectSwapFeeEstimate } from '../../../src/lib/swap-fee.ts'
import {
  buildPublicPrivateSendPreviewRequest,
  createPublicPrivateSendPreviewKey,
  getPublicPrivateSendRouteCost
} from '../../../src/popup/services/public-private-send-preview.ts'

it('continues a combined approval only for the reviewed swap call within its fee ceiling', () => {
  const owner = `0x${'1'.repeat(40)}`
  const call = {
    chainId: 56,
    to: `0x${'2'.repeat(40)}`,
    from: owner,
    data: '0xdeadbeef',
    value: '0'
  }
  const approval = { maximumFeeWei: '50000', maxFeePerGasWei: '1', gasPriceWei: null }
  const limit = getCombinedSwapFeeLimit(call, approval, '550000')
  assert.equal(getCombinedSwapFeeLimit(call, approval, '549999'), null)
  assert.ok(limit)
  const fields = {
    from: owner,
    to: call.to,
    calldata: { encoding: 'hex', value: call.data },
    valueWei: '0',
    maximumFeeWei: '500000',
    maxFeePerGasWei: '1',
    gasPriceWei: null
  }
  const summary = { chainId: 'eip155:56', fields }
  assert.equal(canContinueCombinedSwap(summary, limit, call, owner), true)
  for (const changed of [
    { maximumFeeWei: '500001' },
    { maxFeePerGasWei: '2' },
    { valueWei: '1' },
    { calldata: { encoding: 'hex', value: '0xbeefdead' } }
  ]) {
    assert.equal(
      canContinueCombinedSwap(
        { ...summary, fields: { ...fields, ...changed } },
        limit,
        call,
        owner
      ),
      false
    )
  }
})

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

it('uses the Intents protocol ID when quoting native Shield ZEC to Base USDC', () => {
  const assetId = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const protocolAssetId = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
  const token = {
    assetId: 'nep141:older-base-usdc.omft.near',
    rheaChainId: '8453',
    blockchain: 'base',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    isNative: false
  }
  const managed = [
    {
      assetId,
      protocolAssetId,
      chainId: 'eip155:8453',
      namespace: 'erc20',
      reference: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      decimals: 6
    }
  ]
  const protocolTokens = [{ assetId: protocolAssetId, blockchain: 'base', decimals: 6 }]
  assert.deepEqual(
    resolveNativeZecIntentsDestination(token, null, 'mainnet', managed, protocolTokens),
    { chainId: 'eip155:8453', assetId, protocolAssetId }
  )
  assert.equal(resolveNativeZecIntentsDestination(token, null, 'mainnet', [], protocolTokens), null)
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

it('reuses accepted terms on refresh but binds confirmation to the latest execution and scope', () => {
  const terms = { expected: '100', minimum: '90', route: 'intents' }
  const candidate = { id: 'execution-a', terms, expiresAt: 20_000 }
  const preview = { scope: 'intent-a', baseline: terms, candidate: null }
  const initial = stageQuoteReview(preview, 'intent-a', candidate)
  assert.equal(isQuoteReviewAccepted(initial, 'intent-a', candidate.id, 10_000), true)

  const replacement = { ...candidate, id: 'execution-b' }
  const refreshed = stageQuoteReview(initial, 'intent-a', replacement)
  assert.equal(isQuoteReviewAccepted(refreshed, 'intent-a', replacement.id, 10_000), true)
  assert.equal(canReviewQuote(refreshed, 'intent-a', candidate.id, 10_000), false)
  assert.equal(canReviewQuote(refreshed, 'intent-b', replacement.id, 10_000), false)
  assert.equal(canReviewQuote(refreshed, 'intent-a', replacement.id, 20_000), false)
  assert.equal(stageQuoteReview(refreshed, 'intent-b', replacement), null)
})

it('establishes the first executable price only when building the same indicative quote', () => {
  const baseline = { expected: '3129340784451821', minimum: '3098047376607302', route: 'intents' }
  const preview = { scope: 'intent', baseline, indicativeQuoteHandle: 'quote-a', candidate: null }
  const candidate = {
    id: 'execution-a',
    quoteHandle: 'quote-a',
    terms: { ...baseline, expected: '3128852208142304', minimum: '3097563686060888' },
    expiresAt: 20_000
  }
  const initial = stageQuoteReview(preview, preview.scope, candidate)
  assert.equal(isQuoteReviewAccepted(initial, preview.scope, candidate.id, 10_000), true)

  const replacement = {
    ...candidate,
    id: 'execution-b',
    quoteHandle: 'quote-b',
    terms: { ...candidate.terms, minimum: '3097563686060887' }
  }
  const refreshed = stageQuoteReview(initial, preview.scope, replacement)
  assert.equal(isQuoteReviewAccepted(refreshed, preview.scope, replacement.id, 10_000), false)
  assert.deepEqual(compareQuoteTerms(refreshed.baseline, refreshed.candidate.terms), [
    { field: 'minimum', previous: '3097563686060888', current: '3097563686060887' }
  ])
  const replacedBeforeReview = stageQuoteReview(preview, preview.scope, replacement)
  assert.equal(
    isQuoteReviewAccepted(replacedBeforeReview, preview.scope, replacement.id, 10_000),
    false
  )

  const changedRoute = { ...candidate, terms: { ...candidate.terms, route: 'other' } }
  const differentRoute = stageQuoteReview(preview, preview.scope, changedRoute)
  assert.equal(
    quoteReviewActionLabel(compareQuoteTerms(differentRoute.baseline, changedRoute.terms)),
    'Accept new route'
  )
})

it('keeps an explicit preview baseline across replacement quotes with a lower minimum', () => {
  const baseline = { expected: '100', minimum: '90', route: 'intents' }
  const preview = { scope: 'intent', baseline, candidate: null }
  const candidate = { id: 'execution-a', terms: { ...baseline, minimum: '89' }, expiresAt: 20_000 }
  const first = stageQuoteReview(preview, 'intent', candidate)
  const refreshed = stageQuoteReview(first, 'intent', { ...candidate, id: 'execution-b' })
  assert.equal(isQuoteReviewAccepted(refreshed, 'intent', 'execution-b', 10_000), false)
  assert.deepEqual(compareQuoteTerms(refreshed.baseline, refreshed.candidate.terms), [
    { field: 'minimum', previous: '90', current: '89' }
  ])
  assert.equal(
    quoteReviewActionLabel(compareQuoteTerms(baseline, { ...baseline, route: 'other' })),
    'Accept new route'
  )
  assert.deepEqual(compareQuoteTerms(baseline, { ...baseline, withdrawFee: '1' }), [])
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
    'Request failed. Error details unavailable.'
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

it('uses the native RHEA paths and retries quote reads without replaying writes', async () => {
  const requests = []
  let quoteCalls = 0
  const quoteData = {
    bestQuote: { router: 'sushi', amountOut: '1000', minAmountOut: '990' },
    quoteProviderWarnings: [{ errorCode: 'QUOTE_TIMEOUT' }]
  }
  const buildData = { router: 'sushi', executionType: 'transaction' }
  const api = new RheaSwapApi({
    baseUrl: 'https://api.rhea.finance/',
    apiKey: 'test-key',
    retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    fetch: async (url, init) => {
      requests.push({
        url: new URL(url),
        method: init.method,
        auth: init.headers.Authorization,
        body: init.body && JSON.parse(init.body)
      })
      const path = new URL(url).pathname
      if (path === '/crosschain/swap/quote') {
        if (++quoteCalls === 1) {
          return new Response(
            JSON.stringify({ code: -1, msg: 'provider details', errorCode: 'QUOTE_TIMEOUT' })
          )
        }
        return Response.json({ code: 0, errorCode: '', data: quoteData })
      }
      if (path === '/crosschain/swap/swap') {
        return Response.json({ code: 0, errorCode: '', data: buildData })
      }
      if (path === '/crosschain/swap/report') {
        return new Response('<html>provider private error</html>', { status: 503 })
      }
      if (path === '/api/swap/order-submit') {
        return new Response(JSON.stringify({ code: 500, msg: 'provider private error' }), {
          status: 503
        })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: {} }))
    }
  })

  assert.deepEqual(await api.quote({ fromChain: '1' }), quoteData)
  assert.deepEqual(await api.build({ router: 'route' }), buildData)
  await api.fromTokens(1)
  await api.crossChainToTokens(1)
  await api.orderStatus({ recordId: '123' })
  await assert.rejects(api.submitOrder({ signature: 'test' }), error => {
    assert.equal(error.message, 'RHEA Swap HTTP 503')
    return true
  })
  await assert.rejects(api.report({ from_hash: 'hash' }), error => {
    assert.equal(error.message, 'RHEA Swap HTTP 503')
    return true
  })
  assert.deepEqual(
    requests.map(request => request.url.pathname),
    [
      '/crosschain/swap/quote',
      '/crosschain/swap/quote',
      '/crosschain/swap/swap',
      '/get_chain_prices',
      '/api/swap/supported_to_tokens',
      '/api/swap/order-status',
      '/api/swap/order-submit',
      '/crosschain/swap/report'
    ]
  )
  assert.equal(requests[3].url.searchParams.get('chain'), '1')
  assert.equal(requests[5].url.searchParams.get('recordId'), '123')
  assert.equal(requests[2].body.router, 'route')
  assert.ok(requests.every(request => request.auth === 'Bearer test-key'))
  assert.equal(
    requests.filter(request => request.url.pathname === '/api/swap/order-submit').length,
    1
  )
  assert.equal(
    requests.filter(request => request.url.pathname === '/crosschain/swap/report').length,
    1
  )
})

it('accepts successful RHEA report and order status responses without msg', async () => {
  const api = new RheaSwapApi({
    baseUrl: 'https://api.rhea.finance/',
    fetch: async url =>
      Response.json({
        code: 0,
        errorCode: '',
        data: new URL(url).pathname.endsWith('/report')
          ? { id: 123 }
          : { status: 'SUCCESS', toHash: `0x${'a'.repeat(64)}` }
      })
  })

  assert.deepEqual(await api.report({ from_hash: `0x${'b'.repeat(64)}` }), { id: 123 })
  assert.deepEqual(await api.orderStatus({ recordId: '123' }), {
    status: 'SUCCESS',
    toHash: `0x${'a'.repeat(64)}`
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
      shieldZecSource: 'native-transparent',
      isZecSource: true,
      selectedFundingSource: 'shielded'
    }),
    'transparent'
  )
  assert.equal(
    resolveShieldDomainZecFundingSource({
      ordinarySwapRequested: true,
      shieldZecSource: null,
      isZecSource: true,
      selectedFundingSource: 'shielded'
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
  assert.equal(parseShieldSwapZecSourceParam('native-transparent'), 'native-transparent')
  assert.equal(isShieldSwapZecSelectionId(SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID), true)
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
            asset: {
              id: 'wallet-zec-intents',
              chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
              kind: 'native'
            },
            metadata: { symbol: 'ZEC', decimals: 8, name: 'ZEC' },
            balance: { totalRaw: '0' }
          },
          chain: {
            chain: {
              id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
              family: 'zcash',
              displayName: 'Zcash'
            }
          },
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
    assert.equal(options[0].intentsWalletAssetId, 'wallet-zec-intents')
    assert.equal(options[0].sourceLabel, 'NEAR Confidential')
    assert.equal(options[1].selectionId, SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID)
    assert.equal(options[1].availableRaw, '40000000')
    for (const option of options) {
      assert.equal(option.chainId, input.sources[0].chain.chain.id)
      assert.equal(option.chainName, 'Zcash')
      assert.equal(option.badgeBlockchain, 'zec')
    }
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
