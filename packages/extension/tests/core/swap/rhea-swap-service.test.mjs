import { test } from 'node:test'
import { expect } from '@playwright/test'
import { serializeQuoteRequest } from '@rhea-finance/cross-chain-aggregation-dex'
import { readRheaDestinationHash } from '../../../src/core/services/rhea-swap/rhea-order-status.ts'
import {
  MemoryRheaSwapQuoteSessionStore,
  RHEA_SWAP_CHAIN_CATALOG,
  RheaSwapService,
  parseRheaSwapQuoteRequest,
  toSdkQuoteRequest,
  toRheaSwapToken
} from '../../../src/core/services/rhea-swap/index.ts'

const sourceAsset = Object.freeze({
  chain: 'zcash',
  address: 'nep141:zec.omft.near',
  symbol: 'ZEC',
  decimals: 8,
  isNative: true
})
const destinationAsset = Object.freeze({
  chain: 'near',
  address: 'wrap.near',
  symbol: 'NEAR',
  decimals: 24,
  isNative: true
})
const quoteRequest = Object.freeze({
  fromChain: 'zcash',
  toChain: 'near',
  tokenIn: sourceAsset,
  tokenOut: destinationAsset,
  amountIn: '100000000',
  slippageBps: 50,
  sender: 't1sender',
  recipient: 'alice.near'
})

test('reads destination hashes from RHEA status across EVM and non-EVM routes', () => {
  const evmHash = `0x${'AB'.repeat(32)}`
  const nearHash = '7eWgQaB7C5qS3kfLWmBp4fPJg8gVd5m6kPmMRYn3ntHP'
  expect(readRheaDestinationHash({ toHash: evmHash })).toBe(evmHash.toLowerCase())
  expect(readRheaDestinationHash({ data: { toHash: nearHash } })).toBe(nearHash)
  expect(
    readRheaDestinationHash({
      swapDetails: { destinationChainTxHashes: [{ hash: nearHash }] }
    })
  ).toBe(nearHash)
  expect(() => readRheaDestinationHash({ toHash: 'not-a-transaction-hash' })).toThrow(/invalid/)
})

test('RHEA Swap chain catalog pins all documented mainnets', () => {
  expect(RHEA_SWAP_CHAIN_CATALOG).toHaveLength(25)
  expect(new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.apiChainId)).size).toBe(25)
  expect(new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.tokenListChainId)).size).toBe(25)
  expect(RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.apiChainId === 'zcash')).toMatchObject({
    tokenListChainId: 900010,
    walletFamily: 'zcash'
  })
})

test('quote request parser binds both assets to their selected chains', () => {
  expect(parseRheaSwapQuoteRequest(quoteRequest)).toEqual(quoteRequest)
  expect(() =>
    parseRheaSwapQuoteRequest({
      ...quoteRequest,
      tokenOut: { ...destinationAsset, chain: 'solana' }
    })
  ).toThrow(/chain mismatch/)
})

test('quote request parser forwards only supported confidential routing', () => {
  expect(parseRheaSwapQuoteRequest({ ...quoteRequest, confidentiality: 'basic' })).toEqual({
    ...quoteRequest,
    confidentiality: 'basic'
  })
  expect(() => parseRheaSwapQuoteRequest({ ...quoteRequest, confidentiality: 'advanced' })).toThrow(
    /confidentiality is invalid/
  )
})

test('RHEA Swap quote sends the Noir Swap referral', () => {
  const request = toSdkQuoteRequest(parseRheaSwapQuoteRequest(quoteRequest))
  expect(serializeQuoteRequest(request)).toMatchObject({ referral: 'noir_swap' })
})

test('token adapter preserves the RHEA protocol identity', () => {
  expect(
    toRheaSwapToken({
      ...sourceAsset,
      address: sourceAsset.address,
      assetId: sourceAsset.address,
      blockchain: 'zec',
      contractAddress: null,
      coinType: null,
      name: 'Zcash',
      logoURI: null,
      price: '83.5',
      priceUpdatedAt: 1_788_334_319,
      sources: ['nearintents'],
      raw: {},
      tokenListChainId: 900010
    })
  ).toMatchObject({
    assetId: 'nep141:zec.omft.near',
    blockchain: 'zec',
    price: 83.5,
    rheaChainId: 'zcash',
    tokenListChainId: 900010,
    isNative: true
  })
})

test('token adapter canonicalizes a live native BNB source without changing its quote address', () => {
  expect(
    toRheaSwapToken({
      chain: '56',
      address: '0x0000000000000000000000000000000000000000',
      assetId: '0x0000000000000000000000000000000000000000',
      symbol: 'BNB',
      decimals: 18,
      isNative: true,
      tokenListChainId: 56,
      blockchain: 'bsc',
      contractAddress: null,
      coinType: null,
      name: 'BNB',
      logoURI: null,
      price: '600',
      priceUpdatedAt: null,
      sources: [],
      raw: { address: '0x0000000000000000000000000000000000000000' }
    })
  ).toMatchObject({
    assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
    rheaAddress: '0x0000000000000000000000000000000000000000',
    rheaChainId: '56',
    isNative: true
  })
})

test('token adapter keeps the quote address separate from the displayed protocol asset ID', () => {
  expect(
    toRheaSwapToken({
      chain: 'near',
      address: 'nep141:wrap.near',
      assetId: 'nep141:wrap.near',
      symbol: 'wNEAR',
      decimals: 24,
      isNative: true,
      tokenListChainId: 900001,
      blockchain: 'near',
      contractAddress: null,
      coinType: null,
      name: null,
      logoURI: null,
      price: '1.86',
      priceUpdatedAt: 1_788_361_352,
      sources: ['nearintents'],
      raw: { address: 'wrap.near', assetId: 'nep141:wrap.near' }
    })
  ).toMatchObject({
    assetId: 'nep141:wrap.near',
    rheaAddress: 'wrap.near'
  })

  for (const [chain, tokenListChainId, assetId, quoteAddress, contractAddress] of [
    [
      '42161',
      42161,
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
    ],
    [
      'near',
      900001,
      'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      null
    ]
  ]) {
    expect(
      toRheaSwapToken({
        chain,
        address: assetId,
        assetId,
        symbol: 'USDC',
        decimals: 6,
        isNative: false,
        tokenListChainId,
        blockchain: chain === 'near' ? 'near' : 'arb',
        contractAddress,
        coinType: null,
        name: 'USD Coin',
        logoURI: null,
        price: '1',
        priceUpdatedAt: null,
        sources: ['nearintents'],
        raw: { address: chain === 'near' ? quoteAddress : assetId, assetId }
      })
    ).toMatchObject({ assetId, rheaAddress: quoteAddress })
  }

  for (const [chain, tokenListChainId, assetId, quoteAddress] of [
    ['btc', 900002, 'nep141:btc.omft.near', 'btc'],
    ['solana', 501, 'nep141:sol.omft.near', 'So11111111111111111111111111111111111111112'],
    ['zcash', 900010, 'nep141:zec.omft.near', 'zec']
  ]) {
    expect(
      toRheaSwapToken({
        chain,
        address: assetId,
        assetId,
        symbol: chain.toUpperCase(),
        decimals: 8,
        isNative: chain === 'solana',
        tokenListChainId,
        blockchain: chain,
        contractAddress: null,
        coinType: null,
        name: null,
        logoURI: null,
        price: '1',
        priceUpdatedAt: null,
        sources: ['nearintents'],
        raw: { address: assetId }
      })
    ).toMatchObject({ assetId, rheaAddress: quoteAddress })
  }
})

test('catalog loading limits concurrency and isolates a failed chain', async () => {
  let active = 0
  let maximumActive = 0
  const client = {
    async getFromTokens({ chainId }) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      if (chainId === 10) throw new Error('offline')
      const chain = RHEA_SWAP_CHAIN_CATALOG.find(item => item.tokenListChainId === chainId)
      return [
        {
          chain: chain.apiChainId,
          address: `nep141:evm-${chainId}.omft.near`,
          symbol: `T${chainId}`,
          decimals: 6,
          isNative: false,
          tokenListChainId: chainId,
          blockchain: chain.blockchain,
          assetId: `asset-${chainId}`,
          contractAddress: `0x${chainId.toString(16).padStart(40, '0')}`,
          coinType: null,
          name: null,
          logoURI: null,
          price: '1',
          priceUpdatedAt: null,
          sources: [],
          raw: {}
        }
      ]
    },
    getCrossChainToTokens() {
      throw new Error('unexpected')
    }
  }
  const service = new RheaSwapService(client, new MemoryRheaSwapQuoteSessionStore())
  const result = await service.listTokens({
    direction: 'from',
    tokenListChainIds: [1, 10, 56, 137, 8453, 42161]
  })
  expect(maximumActive).toBeLessThanOrEqual(4)
  expect(result.tokens).toHaveLength(5)
  expect(result.failedChainIds).toEqual([10])
})

test('catalog loading deduplicates native EVM address aliases after canonicalization', async () => {
  const nativeBnb = address => ({
    chain: '56',
    address,
    symbol: 'BNB',
    decimals: 18,
    isNative: true,
    tokenListChainId: 56,
    blockchain: 'bsc',
    assetId: address,
    contractAddress: null,
    coinType: null,
    name: 'BNB',
    logoURI: null,
    price: '600',
    priceUpdatedAt: null,
    sources: [],
    raw: { address }
  })
  const client = {
    async getFromTokens() {
      return [
        nativeBnb('0x0000000000000000000000000000000000000000'),
        nativeBnb('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      ]
    },
    getCrossChainToTokens() {
      throw new Error('unexpected')
    }
  }
  const service = new RheaSwapService(client, new MemoryRheaSwapQuoteSessionStore())

  const result = await service.listTokens({ direction: 'from', tokenListChainIds: [56] })

  expect(result.tokens).toHaveLength(1)
  expect(result.tokens[0]).toMatchObject({
    assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
    rheaAddress: '0x0000000000000000000000000000000000000000'
  })
})

test('quote and build remain bound across a session-store reload', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const calls = []
  const confidentialQuoteRequest = { ...quoteRequest, confidentiality: 'basic' }
  const normalizedRequest = {
    ...confidentialQuoteRequest,
    extensions: { referral: 'noir_swap' },
    quoteWaitingTimeMs: 6000,
    sameChainTimeoutMs: 1500,
    crossChainTimeoutMs: 6000
  }
  const rawQuote = {
    isCrossChain: true,
    chainType: 'zcash',
    bestQuote: {
      router: 'nearintents',
      amountOut: '2500000000000000000000000',
      minAmountOut: '2400000000000000000000000',
      expectedOut: '2500000000000000000000000',
      preSwap: null,
      bridge: null
    }
  }
  const quote = {
    fromChain: 'zcash',
    toChain: 'near',
    tokenIn: sourceAsset,
    tokenOut: destinationAsset,
    amountIn: '100000000',
    estimatedOut: '2500000000000000000000000',
    minAmountOut: '2400000000000000000000000',
    route: {
      router: 'nearintents',
      amountOut: '2500000000000000000000000',
      minAmountOut: '2400000000000000000000000',
      raw: rawQuote.bestQuote
    },
    alternatives: [],
    receivedAt: 1_000,
    expiresAt: 31_000,
    buildContext: {
      request: {
        fromChain: 'zcash',
        toChain: 'near',
        tokenIn: sourceAsset.address,
        tokenOut: destinationAsset.address,
        amountIn: '100000000',
        referral: 'noir_swap',
        slippage: 50,
        quoteWaitingTimeMs: 6000,
        sameChainTimeoutMs: 1500,
        crossChainTimeoutMs: 6000,
        sender: 't1sender',
        recipient: 'alice.near',
        confidentiality: 'basic'
      },
      router: 'nearintents',
      expectedOut: '2500000000000000000000000',
      minAmountOut: '2400000000000000000000000',
      preSwap: null,
      bridge: null
    },
    raw: rawQuote
  }
  const buildRequest = {
    ...quote.buildContext.request,
    router: 'nearintents',
    expectedOut: quote.estimatedOut,
    minAmountOut: quote.minAmountOut,
    preSwap: null,
    bridge: null
  }
  const rawBuild = {
    isCrossChain: true,
    chainType: 'zcash',
    router: 'nearintents',
    fromChain: 'zcash',
    toChain: 'near',
    tokenIn: { address: sourceAsset.address, symbol: 'ZEC', decimals: 8 },
    tokenOut: { address: destinationAsset.address, symbol: 'NEAR', decimals: 24 },
    amountIn: quote.amountIn,
    estimatedOut: quote.estimatedOut,
    minAmountOut: quote.minAmountOut,
    tx: { kind: 'zcash_transfer', amount: quote.amountIn, depositAddress: 't1deposit' },
    approve: null,
    orderId: 'order-1',
    statusRouter: 'nearintents'
  }
  let buildRecipient = 'alice.near'
  const client = {
    async quote(request) {
      expect(request).toEqual(normalizedRequest)
      return quote
    },
    async buildSwap({ quote: received }) {
      expect(received.amountIn).toBe(quote.amountIn)
      return {
        executionId: 'execution-1',
        isCrossChain: true,
        fromChain: 'zcash',
        toChain: 'near',
        tokenIn: sourceAsset,
        tokenOut: destinationAsset,
        amountIn: quote.amountIn,
        estimatedOut: quote.estimatedOut,
        minAmountOut: quote.minAmountOut,
        router: 'nearintents',
        execution: {
          kind: 'zcash-transfer',
          chain: 'zcash',
          amount: quote.amountIn,
          depositAddress: 't1deposit',
          decimals: 8
        },
        request: { ...buildRequest, recipient: buildRecipient },
        raw: rawBuild
      }
    },
    async reportRaw(request) {
      calls.push(['report', request])
      if (calls.length === 1) throw new Error('temporary report failure')
      return { id: 1, from_hash: request.from_hash }
    },
    async getOrderStatusRaw(request) {
      calls.push(['status', request])
      return { status: 'completed', toHash: `0x${'AB'.repeat(32)}` }
    }
  }
  const resetSessions = new MemoryRheaSwapQuoteSessionStore()
  let quoteStarted
  const started = new Promise(resolve => {
    quoteStarted = resolve
  })
  let finishQuote
  const quoteGate = new Promise(resolve => {
    finishQuote = resolve
  })
  const resetService = new RheaSwapService(
    {
      async quote() {
        quoteStarted()
        await quoteGate
        return quote
      }
    },
    resetSessions,
    { createHandle: () => 'reset-overlap' }
  )
  const oldQuote = resetService.quote(confidentialQuoteRequest)
  await started
  await resetService.clearSessions()
  finishQuote()
  await expect(oldQuote).rejects.toThrow('session was cleared')
  expect(await resetSessions.get('rhea-quote:reset-overlap')).toBeNull()

  const replacedRecipientService = new RheaSwapService(
    {
      async quote() {
        return {
          ...quote,
          buildContext: {
            ...quote.buildContext,
            request: { ...quote.buildContext.request, recipient: 'attacker.near' }
          }
        }
      }
    },
    new MemoryRheaSwapQuoteSessionStore()
  )
  await expect(replacedRecipientService.quote(confidentialQuoteRequest)).rejects.toThrow(
    /does not match its request/
  )
  for (const field of ['estimatedOut', 'minAmountOut']) {
    const emptyOutputSessions = new MemoryRheaSwapQuoteSessionStore()
    const emptyOutputService = new RheaSwapService(
      {
        async quote() {
          return { ...quote, [field]: '0' }
        }
      },
      emptyOutputSessions,
      { createHandle: () => 'empty-output' }
    )
    await expect(emptyOutputService.quote(confidentialQuoteRequest)).rejects.toThrow(
      /below the minimum/
    )
    expect(await emptyOutputSessions.get('rhea-quote:empty-output')).toBeNull()
  }
  const replacedBuildService = new RheaSwapService(client, new MemoryRheaSwapQuoteSessionStore(), {
    now: () => 2_000
  })
  const replacedBuildQuote = await replacedBuildService.quote(confidentialQuoteRequest)
  buildRecipient = 'attacker.near'
  await expect(replacedBuildService.prepare(replacedBuildQuote.quoteHandle)).rejects.toThrow(
    /does not match its quote/
  )
  buildRecipient = 'alice.near'
  let now = 2_000
  const service = new RheaSwapService(client, sessions, {
    now: () => now,
    createHandle: () => 'fixed'
  })
  const quoteView = await service.quote(confidentialQuoteRequest)
  expect(quoteView.quoteHandle).toBe('rhea-quote:fixed')
  await expect(sessions.get(quoteView.quoteHandle)).resolves.toMatchObject({
    request: { confidentiality: 'basic' }
  })
  const review = await service.prepare(quoteView.quoteHandle)
  expect(review.execution).toMatchObject({ kind: 'zcash-transfer', target: 't1deposit' })
  expect((await service.readPreparedBuild(quoteView.quoteHandle)).executionId).toBe('execution-1')
  const depositTransfer = { executionId: 'execution-1', to: 't1deposit', amountZats: '100000000' }
  await expect(
    service.readZcashTransferDeadline(quoteView.quoteHandle, depositTransfer)
  ).resolves.toBe(31_000)
  for (const altered of [
    { executionId: 'another-execution' },
    { to: 't1anotherdeposit' },
    { amountZats: '100000001' }
  ]) {
    await expect(
      service.readZcashTransferDeadline(quoteView.quoteHandle, { ...depositTransfer, ...altered })
    ).rejects.toThrow(/does not match/)
  }
  now = 31_000
  await expect(
    service.readZcashTransferDeadline(quoteView.quoteHandle, depositTransfer)
  ).rejects.toThrow(/expired/)
  now = 40_000
  const submission = await service.recordTransactionSubmission(quoteView.quoteHandle, 'source-hash')
  expect(submission).toMatchObject({
    sourceHash: 'source-hash',
    orderId: 'order-1',
    reportStatus: 'pending'
  })
  await expect(service.reportSubmission(quoteView.quoteHandle)).rejects.toThrow(
    'temporary report failure'
  )

  const restored = new RheaSwapService(client, sessions, { now: () => 40_000 })
  await expect(
    restored.recordTransactionSubmission(quoteView.quoteHandle, 'source-hash')
  ).resolves.toMatchObject({ sourceHash: 'source-hash' })
  await expect(restored.reportSubmission(quoteView.quoteHandle)).resolves.toMatchObject({
    sourceHash: 'source-hash',
    reportStatus: 'reported'
  })
  await expect(restored.getOrderStatus(quoteView.quoteHandle)).resolves.toMatchObject({
    orderId: 'order-1',
    status: 'completed',
    destinationHash: `0x${'ab'.repeat(32)}`
  })
  expect(calls.map(([stage]) => stage)).toEqual(['report', 'report', 'status'])
  expect(calls[0][1]).toMatchObject({
    from_hash: 'source-hash',
    from_chain: 'zcash',
    to_chain: 'near',
    amount_in: quote.amountIn,
    estimated_out: quote.estimatedOut,
    router: 'nearintents',
    deposit_address: 't1deposit'
  })

  const publicRouteService = new RheaSwapService(
    {
      ...client,
      async quote() {
        return {
          ...quote,
          route: { ...quote.route, router: 'bitget' },
          buildContext: { ...quote.buildContext, router: 'bitget' }
        }
      }
    },
    new MemoryRheaSwapQuoteSessionStore()
  )
  await expect(publicRouteService.quote(confidentialQuoteRequest)).rejects.toThrow(
    'confidential quote did not use the Near Intents route'
  )
})

test('EVM plan accepts only an exact ERC-20 approval followed by its bound swap transaction', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const sender = '0x52908400098527886E0F7030069857D2E4169EE7'
  const token = '0x2222222222222222222222222222222222222222'
  const spender = '0x3333333333333333333333333333333333333333'
  const router = '0x4444444444444444444444444444444444444444'
  const amount = 1_000_000n
  const approvalData = `0x095ea7b3${spender.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`
  const request = {
    fromChain: '1',
    toChain: 'near',
    tokenIn: token,
    tokenOut: 'wrap.near',
    amountIn: amount.toString(),
    slippage: 50,
    quoteWaitingTimeMs: 3000,
    sameChainTimeoutMs: 500,
    crossChainTimeoutMs: 3000,
    sender,
    recipient: 'alice.near',
    router: 'odos',
    expectedOut: '900000000000000000000000',
    minAmountOut: '890000000000000000000000',
    preSwap: null,
    bridge: null
  }
  const raw = {
    isCrossChain: true,
    chainType: 'evm',
    router: 'odos',
    fromChain: '1',
    toChain: 'near',
    tokenIn: { address: token, symbol: 'USDC', decimals: 6 },
    tokenOut: { address: 'wrap.near', symbol: 'NEAR', decimals: 24 },
    amountIn: amount.toString(),
    estimatedOut: request.expectedOut,
    minAmountOut: request.minAmountOut,
    tx: { chainId: 1, from: sender, to: router, data: '0x1234', value: '0' },
    approve: {
      spender,
      tx: { chainId: 1, from: sender, to: token, data: approvalData, value: '0' }
    }
  }
  await sessions.put({
    schemaVersion: 1,
    quoteHandle: 'rhea-quote:evm',
    request: {
      fromChain: '1',
      toChain: 'near',
      tokenIn: { chain: '1', address: token },
      tokenOut: { chain: 'near', address: 'wrap.near' },
      amountIn: amount.toString(),
      slippageBps: 50,
      quoteWaitingTimeMs: 3000,
      sameChainTimeoutMs: 500,
      crossChainTimeoutMs: 3000,
      sender,
      recipient: 'alice.near'
    },
    quoteRaw: {
      isCrossChain: true,
      chainType: 'evm',
      bestQuote: {
        router: 'odos',
        amountOut: request.expectedOut,
        expectedOut: request.expectedOut,
        minAmountOut: request.minAmountOut,
        preSwap: null,
        bridge: null
      }
    },
    receivedAt: 1_000,
    expiresAt: 31_000,
    build: { executionId: 'execution-evm', request, raw }
  })
  const service = new RheaSwapService({}, sessions, { now: () => 2_000 })
  await expect(service.readEvmTransactionPlan('rhea-quote:evm')).resolves.toMatchObject({
    transaction: { chainId: 1, to: router, value: '0' },
    approval: { spender, amountRaw: amount.toString() }
  })

  await sessions.put({
    ...(await sessions.get('rhea-quote:evm')),
    build: {
      executionId: 'execution-evm',
      request,
      raw: {
        ...raw,
        executionType: 'signature',
        tx: null,
        signingRequest: {
          type: 'order',
          router: 'odos',
          quoteId: 'quote-evm',
          chainId: 1,
          signingScheme: 'eip712',
          typedData: {
            domain: { chainId: 1 },
            types: { Order: [{ name: 'maker', type: 'address' }] },
            primaryType: 'Order',
            message: { maker: sender }
          }
        }
      }
    }
  })
  await expect(service.readEvmSignaturePlan('rhea-quote:evm')).resolves.toMatchObject({
    chainId: 1,
    sender,
    approval: { spender, amountRaw: amount.toString() }
  })

  let submittedOrders = 0
  const submissionService = new RheaSwapService(
    {
      async submitOrderRaw() {
        submittedOrders += 1
        await Promise.resolve()
        return { orderId: 'order-evm', router: 'odos', chainId: 1 }
      }
    },
    sessions,
    { now: () => 2_000 }
  )
  const signature = `0x${'11'.repeat(65)}`
  const submissions = await Promise.all([
    submissionService.submitSignedOrder('rhea-quote:evm', signature, 'eip712'),
    submissionService.submitSignedOrder('rhea-quote:evm', signature, 'eip712')
  ])
  expect(submittedOrders).toBe(1)
  expect(submissions[0]).toEqual(submissions[1])

  await sessions.put({
    ...(await sessions.get('rhea-quote:evm')),
    build: {
      executionId: 'execution-evm',
      request,
      raw: {
        ...raw,
        approve: {
          ...raw.approve,
          tx: { ...raw.approve.tx, to: router }
        }
      }
    }
  })
  await expect(service.readEvmTransactionPlan('rhea-quote:evm')).rejects.toThrow(
    /does not match the quoted source asset/
  )

  await sessions.put({
    ...(await sessions.get('rhea-quote:evm')),
    build: {
      executionId: 'execution-evm',
      request,
      raw: {
        ...raw,
        approve: {
          ...raw.approve,
          tx: {
            ...raw.approve.tx,
            data: `0x095ea7b3${spender.slice(2).padStart(64, '0')}${(amount + 1n).toString(16).padStart(64, '0')}`
          }
        }
      }
    }
  })
  await expect(service.readEvmTransactionPlan('rhea-quote:evm')).rejects.toThrow(
    /does not match the quoted source asset/
  )
})
