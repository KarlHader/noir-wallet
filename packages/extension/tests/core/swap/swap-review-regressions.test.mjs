import assert from 'node:assert/strict'
import { it } from 'node:test'
import { CombinedEvmSwap } from '../../../src/background/combined-evm-swap.ts'
import { EvmTransactionError } from '../../../src/infrastructure/chains/evm/evm-transaction-builder.ts'
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
  shieldSwapPreviewTerms,
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
  buildShieldDestinationPickerRows,
  buildShieldSwapPreviewRequest,
  buildShieldSwapRequest,
  matchesShieldSwapReview,
  sortShieldSwapPickerRows
} from '../../../src/popup/services/shield-swap-form.ts'
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

function combinedSwapFixture(t, executionMode) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 })
  const owner = `0x${'1'.repeat(40)}`
  const target = `0x${'2'.repeat(40)}`
  const token = `0x${'3'.repeat(40)}`
  const scope = { keyDomainId: 'wallet:combined', accountId: 'account:combined' }
  const approvalId = 'tx:evm:combined-approve'
  const approvalFingerprint = 'a'.repeat(64)
  const swapId = 'tx:evm:combined-swap'
  const approvalHash = `0x${'a'.repeat(64)}`
  const swapHash = `0x${'b'.repeat(64)}`
  const approval = {
    transaction: { chainId: 42161, to: token, data: '0xdeadbeef', value: '0' },
    spender: target,
    amountRaw: '1000'
  }
  const transaction = { chainId: 42161, to: target, data: '0x1234', value: '0' }
  const binding = {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:combined',
    executionId: 'execution:combined',
    router: 'test-router',
    sourceTarget: target,
    sender: owner,
    originAmountRaw: '1000',
    expiresAt: 100_000,
    isCrossChain: false,
    origin: {
      chainId: 'eip155:42161',
      assetId: `eip155:42161/erc20:${token}`,
      protocolChainId: '42161',
      protocolAssetId: token
    },
    destination: {
      chainId: 'eip155:42161',
      assetId: 'eip155:42161/slip44:60',
      protocolChainId: '42161',
      protocolAssetId: 'native',
      recipient: owner,
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
  const input = {
    approvalId,
    approvalFingerprint,
    binding,
    ...(executionMode ? { executionMode } : {}),
    feeBudgetWei: '550000',
    feeSelection: 'standard'
  }
  const account = {
    network: 'mainnet',
    walletId: scope.keyDomainId,
    accountId: scope.accountId,
    unlockEpoch: 'unlocked'
  }
  const graphs = new Map()
  const storage = {}
  const calls = []
  let allowance = '0'
  let delayedBroadcast = false
  let preparationError
  const setStatus = (id, kind, status, hash) => {
    const graph = {
      root: { id, scope, kind, status },
      segments: [{ role: 'origin', status, evidence: hash ? { transactionHash: hash } : undefined }]
    }
    graphs.set(id, graph)
    return graph
  }
  setStatus(approvalId, 'approve', 'prepared')
  const summary = (call, maximumFeeWei) => ({
    schema: 'evm.transaction.v1',
    chainId: 'eip155:42161',
    fields: {
      from: owner,
      to: call.to,
      valueWei: call.value,
      calldata: { encoding: 'hex', value: call.data },
      maximumFeeWei,
      maxFeePerGasWei: '1',
      gasPriceWei: null
    }
  })
  const router = {
    getPendingApproval: async id => {
      const graph = graphs.get(id)
      if (graph?.root.status !== 'prepared') return null
      return {
        graph,
        review: {
          payloadFingerprint: {
            digestHex: id === approvalId ? approvalFingerprint : 'b'.repeat(64)
          },
          summary:
            id === approvalId
              ? summary(approval.transaction, '50000')
              : summary(transaction, '450000')
        }
      }
    },
    approve: async (id, _fingerprint, authorize) => {
      await authorize()
      if (id === approvalId) {
        assert.ok(
          Object.keys(storage).length,
          'the reviewed intent survives before the approval broadcast'
        )
        calls.push('approve-token')
        return {
          status: 'broadcast',
          graph: setStatus(approvalId, 'approve', 'broadcast', approvalHash)
        }
      }
      calls.push('sign-swap')
      assert.equal(id, swapId)
      assert.ok(
        Object.values(storage).some(item => item.swap?.id === id),
        'the same swap ID is reserved before signing'
      )
      return delayedBroadcast
        ? { status: 'signed-pending-broadcast', graph: setStatus(id, 'swap', 'signed', swapHash) }
        : { status: 'broadcast', graph: setStatus(id, 'swap', 'broadcast', swapHash) }
    },
    prepareContractCall: async (_intent, _fee, reviewedBinding, mode) => {
      assert.equal(mode, executionMode ?? 'main')
      assert.equal(reviewedBinding.sender, owner)
      calls.push('prepare-swap')
      if (preparationError) throw preparationError
      return {
        graph: setStatus(swapId, 'swap', 'prepared'),
        review: {
          payloadFingerprint: { digestHex: 'b'.repeat(64) },
          summary: summary(transaction, '450000')
        }
      }
    },
    getTokenAllowance: async (_chain, _token, _spender, allowanceOwner, mode) => {
      assert.equal(mode, executionMode ?? 'main')
      assert.equal(allowanceOwner, owner)
      return allowance
    },
    resumeBroadcast: async id => {
      assert.equal(id, swapId)
      calls.push('retry-same-signed-swap')
      return { status: 'broadcast', graph: setStatus(id, 'swap', 'broadcast', swapHash) }
    }
  }
  const previousChrome = globalThis.chrome
  globalThis.chrome = {
    storage: {
      session: {
        get: async key => structuredClone(key === null ? storage : { [key]: storage[key] }),
        set: async records => Object.assign(storage, structuredClone(records)),
        remove: async key => delete storage[key]
      }
    }
  }
  t.after(() => {
    globalThis.chrome = previousChrome
  })
  const options = {
    router: () => router,
    quote: {
      readQuoteView: async () => ({ receivedAt: 10_000, expiresAt: binding.expiresAt }),
      readPreparedBuild: async () => ({
        amountIn: '1000',
        estimatedOut: '900',
        minAmountOut: '850'
      }),
      readEvmTransactionPlan: async () => ({
        executionId: binding.executionId,
        transaction,
        approval
      })
    },
    readAccount: async () => account,
    readGraph: async (_scope, id) => {
      const graph = graphs.get(id)
      return graph?.root.status === 'prepared' ? null : (graph ?? null)
    },
    validateQuote: async (_binding, mode) => assert.equal(mode, executionMode ?? 'main'),
    checkApproval: async () => {},
    schedule: async () => {}
  }
  return {
    create: () => new CombinedEvmSwap(options),
    input,
    calls,
    approveOnchain: () => setStatus(approvalId, 'approve', 'final', approvalHash),
    failOnchain: () => setStatus(approvalId, 'approve', 'failed', approvalHash),
    setAllowance: () => {
      allowance = '1000'
    },
    delayBroadcast: () => {
      delayedBroadcast = true
    },
    failPreparation: error => {
      preparationError = error
    },
    changeUnlock: () => {
      account.unlockEpoch = 'different'
    }
  }
}

it('resumes an approved swap from background storage and retries only the same signed transaction', async t => {
  for (const [name, mode] of [
    ['Public', undefined],
    ['Incognito', 'private']
  ]) {
    await t.test(name, async subtest => {
      const fixture = combinedSwapFixture(subtest, mode)
      const original = fixture.create()
      assert.equal((await original.start(fixture.input)).status, 'approving')
      fixture.approveOnchain()
      fixture.delayBroadcast()
      const resumed = fixture.create()
      await resumed.poll()
      assert.deepEqual(fixture.calls, ['approve-token'])
      fixture.setAllowance()
      await resumed.poll()
      assert.equal((await resumed.get(fixture.input.approvalId)).status, 'submitting')
      const restarted = fixture.create()
      await Promise.all([restarted.poll(), restarted.poll()])
      await restarted.poll()
      assert.equal((await restarted.get(fixture.input.approvalId)).status, 'broadcast')
      assert.deepEqual(fixture.calls, [
        'approve-token',
        'prepare-swap',
        'sign-swap',
        'retry-same-signed-swap'
      ])
    })
  }
})

it('stops before signing when authorization, quote or transaction preparation requires another review', async t => {
  for (const scenario of [
    'failed',
    'expired',
    'locked',
    'insufficient-funds',
    'simulation-failed'
  ]) {
    await t.test(scenario, async subtest => {
      const fixture = combinedSwapFixture(subtest)
      await fixture.create().start(fixture.input)
      if (scenario === 'failed') {
        fixture.failOnchain()
      } else {
        fixture.approveOnchain()
        fixture.setAllowance()
        if (scenario === 'expired') subtest.mock.timers.setTime(fixture.input.binding.expiresAt)
        else if (scenario === 'locked') fixture.changeUnlock()
        else fixture.failPreparation(new EvmTransactionError(scenario, 'Test preparation error'))
      }
      const resumed = fixture.create()
      await resumed.poll()
      const result = await resumed.get(fixture.input.approvalId)
      assert.equal(result.status, scenario === 'failed' ? 'approval-failed' : 'review-required')
      if (scenario === 'expired') assert.match(result.message, /quote expired/i)
      if (scenario === 'insufficient-funds') assert.match(result.message, /network fee/i)
      if (scenario === 'simulation-failed') assert.match(result.message, /failed simulation/i)
      assert.deepEqual(
        fixture.calls,
        ['insufficient-funds', 'simulation-failed'].includes(scenario)
          ? ['approve-token', 'prepare-swap']
          : ['approve-token']
      )
    })
  }
})

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

it('uses the first firm Shield Swap price and still requires consent for later price changes', () => {
  const preview = {
    amountOutRaw: '3098100',
    minimumOutputRaw: '3067100',
    appFeeBps: 20,
    expiresAt: 15_000
  }
  const session = {
    scope: 'shield-swap',
    baseline: shieldSwapPreviewTerms(preview, 'swap'),
    candidate: null
  }
  const firmQuote = {
    id: 'firm-quote',
    terms: { expected: '3098300', minimum: '3067317', appFeeBps: 20 },
    expiresAt: 20_000
  }
  const initial = stageQuoteReview(session, session.scope, firmQuote)
  assert.equal(isQuoteReviewAccepted(initial, session.scope, firmQuote.id, 10_000), true)

  const refreshedQuote = {
    ...firmQuote,
    id: 'refreshed-quote',
    terms: { ...firmQuote.terms, minimum: '3067000' }
  }
  const refreshed = stageQuoteReview(initial, session.scope, refreshedQuote)
  assert.equal(isQuoteReviewAccepted(refreshed, session.scope, refreshedQuote.id, 10_000), false)
  assert.deepEqual(compareQuoteTerms(refreshed.baseline, refreshedQuote.terms), [
    { field: 'minimum', previous: '3067317', current: '3067000' }
  ])

  const changedFee = { ...firmQuote, terms: { ...firmQuote.terms, appFeeBps: 30 } }
  const initialWithChangedFee = stageQuoteReview(session, session.scope, changedFee)
  assert.equal(
    isQuoteReviewAccepted(initialWithChangedFee, session.scope, firmQuote.id, 10_000),
    false
  )

  const withdrawSession = { ...session, baseline: shieldSwapPreviewTerms(preview, 'withdraw') }
  const changedWithdraw = stageQuoteReview(withdrawSession, session.scope, firmQuote)
  assert.equal(isQuoteReviewAccepted(changedWithdraw, session.scope, firmQuote.id, 10_000), false)
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
    quoteMode: 'fast',
    feeSelectionKey: 'standard',
    sourceToken: token,
    destinationToken: token
  }
  const preview = buildPublicPrivateSendPreviewRequest(input)
  assert.equal(preview.key, createPublicPrivateSendPreviewKey(input))
  assert.equal(preview.request.confidentiality, 'basic')
  assert.equal(preview.request.amountIn, '500000')
  assert.equal(preview.request.quoteMode, 'fast')
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
    { quoteMode: 'best-price' },
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

it('distinguishes an exhausted route from retryable aggregate quote failures', async () => {
  const noRoute = [
    'lifi: LI.FI unsupported destination chain',
    'rango: route does not support this chain pair'
  ]
  for (const [errors, expected] of [
    [noRoute, { message: 'no route', retryable: false }],
    [[...noRoute, 'nearintents quote timeout after 2s'], { message: 'no route', retryable: true }],
    [
      [...noRoute, 'contract: all Rhea bridge quotes failed'],
      { message: 'Request failed.', retryable: true }
    ]
  ]) {
    const api = new RheaSwapApi({
      baseUrl: 'https://quote.invalid',
      retry: { maxRetries: 0 },
      fetch: async () =>
        Response.json({ code: 400, data: { errors }, errorCode: '' }, { status: 400 })
    })
    await assert.rejects(api.quote({}), error => {
      const runtimeMessage = getSafeRheaSwapRuntimeErrorMessage(error)
      assert.deepEqual(getRheaSwapQuoteFailure(new RheaSwapClientError(runtimeMessage)), expected)
      return true
    })
  }
})

it('keeps a quote connection failure retryable with no route as the result', () => {
  assert.deepEqual(getRheaSwapQuoteFailure(new RheaSwapClientError('fetch failed')), {
    message: 'no route',
    retryable: true
  })
  const error = new RheaSwapClientError('gRPC transport error: UNAVAILABLE')
  assert.deepEqual(getRheaSwapQuoteFailure(error), { message: 'no route', retryable: true })
  assert.equal(
    getRheaSwapErrorMessage(error),
    'Network connection failed. Please check your internet and try again.'
  )
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
  const confidential = { confidentiality: 'basic' }
  await assert.rejects(api.quote(confidential), /require 1Click/)
  await assert.rejects(api.build(confidential), /require 1Click/)
  await assert.rejects(api.report(confidential), /require 1Click/)
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

it('ranks Shield Swap destinations by wallet balance value and distinguishes EVM networks', () => {
  const ethDestination = (chainId, displayName, protocolAssetId) => {
    const assetId = `${chainId}/slip44:60`
    return {
      asset: {
        asset: { id: assetId, chainId, kind: 'native', reference: '60' },
        metadata: { symbol: 'ETH', decimals: 18, name: 'Ether' }
      },
      chain: { chain: { id: chainId, family: 'evm', displayName } },
      managed: { chainId, assetId, protocolAssetId }
    }
  }
  const ethereum = ethDestination('eip155:1', 'Ethereum', 'nep141:eth.omft.near')
  const base = ethDestination('eip155:8453', 'Base', 'nep141:base-eth.omft.near')
  const rows = buildShieldDestinationPickerRows({
    network: 'mainnet',
    options: [ethereum, base],
    tokens: [
      { assetId: 'nep141:zec.omft.near', price: 100 },
      { assetId: ethereum.managed.protocolAssetId, price: 2000 },
      { assetId: base.managed.protocolAssetId, price: 2000 }
    ],
    balances: [
      { tokenId: ethereum.managed.protocolAssetId, available: '60000000000000000' },
      { tokenId: base.managed.protocolAssetId, available: '25000000000000000' }
    ],
    nativeZecDestinations: [
      { fundingSource: 'transparent', address: 'transparent-address', availableRaw: '0' },
      { fundingSource: 'shielded', address: 'shielded-address', availableRaw: '100000000' }
    ]
  })
  assert.deepEqual(
    sortShieldSwapPickerRows(rows).map(row => [row.key, row.chainName, row.badgeBlockchain]),
    [
      ['native-zec-destination:shielded', 'Zcash', 'zec'],
      ['native-zec-destination:transparent', 'Zcash', 'zec'],
      [ethereum.managed.assetId, 'Ethereum', 'eth'],
      [base.managed.assetId, 'Base', 'base']
    ]
  )
})

it('only routes same-asset Confidential ZEC to the account Unified Address and binds its review', () => {
  const chainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const assetId = `${chainId}/slip44:133`
  const protocolAssetId = 'nep141:zec.omft.near'
  const transparent = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F'
  const unified =
    'u1nvgt6yr35mhc9wdf4wckvl38476vqy96dx3cwkfdwy4jet9300l5v8l2yg27ql7w9qwm0lf8kncnj9nus4mgete06j3cu3mhrqvstg6swvdya6xgzwhh6a9xxdhxkavvvmztqeuaurjtqfk3dzetuzgnu0zjvmdpe8ehvj53sy6yhzxj'
  const zec = {
    asset: {
      asset: { id: assetId, chainId, kind: 'native', reference: '133' },
      metadata: { symbol: 'ZEC', decimals: 8, name: 'Zcash' }
    },
    chain: {
      chain: {
        id: chainId,
        family: 'zcash',
        displayName: 'Zcash',
        capabilities: { transaction: { status: 'available' } }
      }
    },
    managed: { chainId, assetId, protocolAssetId, blockchain: 'zec' }
  }
  const balances = [{ tokenId: protocolAssetId, available: '1000000' }]
  const picker = {
    network: 'mainnet',
    source: zec,
    options: [zec],
    tokens: [],
    balances,
    nativeZecDestinations: [
      { fundingSource: 'transparent', address: transparent, availableRaw: '0' },
      { fundingSource: 'shielded', address: unified, availableRaw: '0' }
    ]
  }
  assert.deepEqual(
    buildShieldDestinationPickerRows({ ...picker, source: null }).map(row => [
      row.key,
      row.zcashFundingSource ?? row.sourceLabel
    ]),
    [
      ['native-zec-destination:transparent', 'transparent'],
      ['native-zec-destination:shielded', 'shielded'],
      [assetId, 'NEAR Confidential']
    ]
  )
  assert.deepEqual(
    buildShieldDestinationPickerRows(picker).map(row => row.key),
    ['native-zec-destination:shielded']
  )
  assert.deepEqual(buildShieldDestinationPickerRows({ ...picker, nativeZecDestinations: [] }), [])

  const input = {
    network: 'mainnet',
    keyDomainId: 'wallet',
    accountId: 'account',
    from: zec,
    to: zec,
    amount: '0.01',
    balances,
    slippageBps: 50,
    nativeZecRecipient: unified,
    nativeZecFundingSource: 'shielded'
  }
  const request = buildShieldSwapRequest(input)
  assert.equal(request.purpose, 'same-asset-zec-swap')
  assert.equal(request.operation, 'withdraw')
  assert.equal(request.sourceDomain, 'shield')
  assert.equal(request.destinationDomain, 'public')
  assert.equal(request.source.protocolAssetId, protocolAssetId)
  assert.equal(request.source.amountRaw, '1000000')
  assert.equal(request.destination.assetId, assetId)
  assert.equal(request.externalRecipient, unified)
  assert.deepEqual(buildShieldSwapPreviewRequest(input), request)
  for (const change of [
    { nativeZecRecipient: undefined, nativeZecFundingSource: undefined },
    { nativeZecRecipient: transparent },
    { nativeZecFundingSource: 'transparent' },
    { from: { ...zec, managed: { ...zec.managed, assetId: 'not-native-zec' } } },
    { amount: '0.01000001' }
  ]) {
    assert.throws(() => buildShieldSwapRequest({ ...input, ...change }), /unavailable/)
  }

  const review = {
    purpose: 'same-asset-zec-swap',
    operation: 'withdraw',
    sourceDomain: 'shield',
    destinationDomain: 'public',
    network: 'mainnet',
    keyDomainId: 'wallet',
    accountId: 'account',
    sourceAmountRaw: '1000000',
    withdrawCount: 1,
    requiresDeposit: false,
    externalRecipient: unified,
    destinationAddress: unified
  }
  assert.equal(matchesShieldSwapReview(review, request), true)
  for (const change of [
    { purpose: 'native-zec-swap' },
    { accountId: 'other-account' },
    { sourceAmountRaw: '1000001' },
    { destinationAddress: transparent }
  ]) {
    assert.equal(matchesShieldSwapReview({ ...review, ...change }, request), false)
  }
})
