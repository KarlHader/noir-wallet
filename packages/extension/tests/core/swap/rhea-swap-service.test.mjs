import { test } from 'node:test'
import { expect } from '@playwright/test'
import { decodeFunctionData, erc20Abi } from 'viem'
import { ConfidentialFundingApi } from '../../../src/background/confidential-funding-api.ts'
import { PublicConfidentialTransfer } from '../../../src/background/public-confidential-transfer.ts'
import { RheaSwapCatalogClient } from '../../../src/core/services/rhea-swap/rhea-swap-catalog-client.ts'
import {
  createSwapBuildRequest,
  normalizeBuild,
  normalizeQuote,
  serializeQuoteRequest
} from '../../../src/core/services/rhea-swap/rhea-swap-protocol.ts'
import { getZcashChainId } from '../../../src/core/chains/registry/index.ts'
import { parseTrustedExtensionRuntimeMessage } from '../../../src/lib/runtime-message-security.ts'
import { readRheaDestinationHash } from '../../../src/core/services/rhea-swap/rhea-order-status.ts'
import { parseRheaSwapReviewView } from '../../../src/core/services/rhea-swap/rhea-swap-runtime.ts'
import {
  MemoryRheaSwapQuoteSessionStore,
  RHEA_SWAP_CHAIN_CATALOG,
  RheaSwapService,
  assertPrivateQuoteRoute,
  parseRheaSwapQuoteRequest,
  toRheaSwapProtocolRequest,
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

test('uses the 1Click route and refund owner for all basic confidential quotes and builds', async () => {
  const usdcAddress = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const depositAddress = '0x4444444444444444444444444444444444444444'
  const usdc = { assetId: `nep141:base-${usdcAddress}.omft.near`, symbol: 'USDC', decimals: 6 }
  const arbitrumAddress = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
  const arbitrumUsdc = {
    assetId: `nep141:arb-${arbitrumAddress}.omft.near`,
    symbol: 'USDC',
    decimals: 6
  }
  const sol = { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9 }
  const solRecipient = 'A7eWgQaB7C5qS3kfLWmBp4fPJg8gVd5m6kPmMRYn3ntH'
  const asset = { chain: '8453', address: usdcAddress, symbol: 'USDC', decimals: 6 }
  const request = {
    fromChain: '8453',
    toChain: '8453',
    tokenIn: asset,
    tokenOut: asset,
    amountIn: '1000000',
    slippageBps: 50,
    sender: '0x1111111111111111111111111111111111111111',
    recipient: '0x2222222222222222222222222222222222222222',
    confidentiality: 'basic'
  }
  const config = {
    oneClickApiUrl: 'https://example.test/1click',
    oneClickDirectApiUrl: 'https://example.test/1click',
    rheaSwapApiUrl: 'https://example.test'
  }
  const fees = [{ recipient: 'noir_swap.near', fee: 2 }]
  const originalFetch = globalThis.fetch
  let referral
  let destination = usdc
  let repeatFeeInBaseline = false
  let repeatFeeInBuild = false
  let shieldRefundAddress
  let wrongBuildRefund = false
  globalThis.fetch = async (url, init) => {
    expect(url).toBe(`${config.oneClickApiUrl}/quote`)
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      referral,
      originAsset: usdc.assetId,
      destinationAsset: destination.assetId,
      amount: request.amountIn,
      refundTo: shieldRefundAddress ?? request.sender,
      refundType: shieldRefundAddress ? 'CONFIDENTIAL_INTENTS' : 'ORIGIN_CHAIN',
      recipient: destination === sol ? solRecipient : request.recipient,
      recipientType: 'DESTINATION_CHAIN',
      confidentiality: 'basic'
    })
    if (body.dry) {
      expect(body.user).toBeUndefined()
      expect(body.userChainFamily).toBeUndefined()
    } else {
      expect(body).toMatchObject({
        user: shieldRefundAddress ?? request.sender,
        userChainFamily: 'evm'
      })
    }
    if (referral === 'noir_swap') expect(body.appFees).toBeUndefined()
    else if (body.appFees) expect(body.appFees).toEqual(fees)
    else expect(body.dry).toBe(true)
    const appFees =
      repeatFeeInBaseline || (repeatFeeInBuild && !body.dry)
        ? body.appFees
          ? [...body.appFees, ...fees]
          : fees
        : (body.appFees ?? [])
    return Response.json({
      correlationId: 'public-confidential-quote',
      quoteRequest: {
        ...body,
        appFees,
        ...(!body.dry && wrongBuildRefund ? { refundTo: request.sender } : {})
      },
      quote: {
        amountIn: body.amount,
        amountOut: body.appFees ? '999800' : '1000000',
        minAmountOut: body.appFees ? '994801' : '995000',
        deadline: body.deadline,
        depositAddress: body.dry ? undefined : depositAddress
      }
    })
  }
  try {
    let status = null
    const reads = []
    const adapter = new PublicConfidentialTransfer(
      new ConfidentialFundingApi(config, '', ''),
      async input => {
        reads.push(input)
        return status
      },
      async () => [usdc, sol, arbitrumUsdc],
      undefined,
      async () => '0x5555555555555555555555555555555555555555'
    )
    const client = new RheaSwapCatalogClient({
      baseUrl: config.rheaSwapApiUrl,
      publicConfidentialTransfer: adapter
    })
    const sessions = new MemoryRheaSwapQuoteSessionStore()
    const service = new RheaSwapService(client, sessions)
    const scope = { walletId: 'wallet', accountId: 'account' }
    for (const [purpose, expectedReferral] of [
      ['public-private-send', 'noir_privately'],
      ['public-private-move', 'noir_move'],
      ['private-dapp-transfer', 'noir_swap']
    ]) {
      referral = expectedReferral
      const quote = await service.quote(request, undefined, { ...scope, purpose })
      const privateRefund = purpose === 'private-dapp-transfer'
      expect(quote).toMatchObject({
        estimatedOut: privateRefund ? '1000000' : '999800',
        minAmountOut: privateRefund ? '995000' : '994801'
      })
      const review = await service.prepare(quote.quoteHandle)
      const prepared = await service.readPreparedBuild(quote.quoteHandle)
      expect(prepared.deposit?.viewer).toEqual({
        chainFamily: 'evm',
        walletAddress: request.sender,
        signingMode: privateRefund ? 'private' : 'public'
      })
      expect(review).toMatchObject({
        amountIn: request.amountIn,
        estimatedOut: quote.estimatedOut,
        minAmountOut: quote.minAmountOut
      })
      const plan = await service.readEvmTransactionPlan(quote.quoteHandle)
      expect(plan).toMatchObject({ approval: null, transaction: { to: usdcAddress, value: '0' } })
      expect(decodeFunctionData({ abi: erc20Abi, data: plan.transaction.data })).toEqual({
        functionName: 'transfer',
        args: [depositAddress, BigInt(request.amountIn)]
      })
      if (!privateRefund) {
        repeatFeeInBuild = true
        await expect(service.prepare(quote.quoteHandle)).rejects.toThrow('app fees do not match')
        repeatFeeInBuild = false
      }
      const sourceHash = `0x${'10'.repeat(32)}`
      const destinationHash = `0x${'20'.repeat(32)}`
      await service.recordTransactionSubmission(quote.quoteHandle, sourceHash)
      const restarted = new RheaSwapService(client, sessions)
      await expect(restarted.reportSubmission(quote.quoteHandle)).resolves.toMatchObject({
        reportStatus: 'reported',
        orderId: depositAddress
      })
      status = null
      await expect(restarted.getOrderStatus(quote.quoteHandle)).resolves.toMatchObject({
        status: 'unknown',
        destinationHash: null
      })
      expect(reads.at(-1)).toMatchObject({
        network: 'mainnet',
        ...scope,
        order: {
          depositAddress,
          viewer: {
            chainFamily: 'evm',
            walletAddress: request.sender,
            signingMode: privateRefund ? 'private' : 'public'
          }
        }
      })
      status = { status: 'SUCCESS', toHash: destinationHash }
      await expect(service.getOrderStatus(quote.quoteHandle)).resolves.toMatchObject({
        status: 'completed',
        destinationHash
      })
    }
    referral = 'noir_swap'
    shieldRefundAddress = '0x5555555555555555555555555555555555555555'
    for (const crossChain of [false, true]) {
      destination = crossChain ? arbitrumUsdc : usdc
      const quote = await service.quote(
        {
          ...request,
          ...(crossChain
            ? {
                toChain: '42161',
                tokenOut: { ...asset, chain: '42161', address: arbitrumAddress }
              }
            : {})
        },
        undefined,
        { ...scope, purpose: crossChain ? 'private-cross-chain-withdraw' : 'private-transfer' }
      )
      wrongBuildRefund = true
      await expect(service.prepare(quote.quoteHandle)).rejects.toThrow('funding route')
      wrongBuildRefund = false
      await service.prepare(quote.quoteHandle)
      const prepared = await service.readPreparedBuild(quote.quoteHandle)
      expect(prepared.deposit?.viewer).toEqual({
        chainFamily: 'evm',
        walletAddress: shieldRefundAddress,
        signingMode: 'public'
      })
      await expect(service.readEvmTransactionPlan(quote.quoteHandle)).resolves.toMatchObject({
        transaction: { from: request.sender }
      })
      await service.recordTransactionSubmission(quote.quoteHandle, `0x${'30'.repeat(32)}`)
      const restarted = new RheaSwapService(client, sessions)
      status = { status: 'REFUNDED' }
      await restarted.reportSubmission(quote.quoteHandle)
      await expect(restarted.getOrderStatus(quote.quoteHandle)).resolves.toMatchObject({
        status: 'refunded'
      })
      expect(reads.at(-1).order.viewer.walletAddress).toBe(shieldRefundAddress)
    }

    shieldRefundAddress = undefined
    destination = sol
    const crossChainQuote = await service.quote(
      {
        ...request,
        toChain: 'solana',
        tokenOut: {
          chain: 'solana',
          address: 'So11111111111111111111111111111111111111112',
          decimals: 9
        },
        recipient: solRecipient
      },
      undefined,
      { ...scope, purpose: 'private-cross-chain-send' }
    )
    await expect(service.prepare(crossChainQuote.quoteHandle)).resolves.toMatchObject({
      isCrossChain: true,
      tokenOut: { chain: 'solana', symbol: 'SOL' }
    })
    const record = await sessions.get(crossChainQuote.quoteHandle)
    await sessions.put({
      ...record,
      build: undefined,
      quoteRaw: { ...record.quoteRaw, bestQuote: { ...record.quoteRaw.bestQuote, bridge: null } }
    })
    await expect(service.prepare(crossChainQuote.quoteHandle)).rejects.toThrow('Get a new quote')

    referral = 'noir_move'
    destination = usdc
    repeatFeeInBaseline = true
    await expect(
      service.quote(request, undefined, { ...scope, purpose: 'public-private-move' })
    ).rejects.toThrow('already includes the wallet fee recipient')
  } finally {
    globalThis.fetch = originalFetch
  }
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
  expect(RHEA_SWAP_CHAIN_CATALOG).toHaveLength(26)
  expect(new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.apiChainId)).size).toBe(26)
  expect(new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.tokenListChainId)).size).toBe(26)
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

test('trusted quote messages retain the reviewed wallet route purpose', () => {
  for (const purpose of [
    'wallet-swap',
    'public-cross-chain-send',
    'confidential-funding',
    'private-cross-chain-withdraw'
  ]) {
    const message = { type: 'QUOTE_RHEA_SWAP', request: quoteRequest, purpose }
    expect(parseTrustedExtensionRuntimeMessage(message)).toEqual(message)
  }
})

test('cross-chain Withdraw authorizes the same-account Public destination and canonical asset', () => {
  const source = {
    chainId: 'eip155:1',
    privateExecutionAddress: `0x${'1'.repeat(40)}`,
    addresses: [{ value: `0x${'2'.repeat(40)}` }]
  }
  const destination = {
    chainId: 'eip155:42161',
    privateExecutionAddress: `0x${'3'.repeat(40)}`,
    addresses: [{ value: `0x${'4'.repeat(40)}` }]
  }
  const account = { walletId: 'wallet-1', accountId: 'account-1', networks: [source, destination] }
  const route = {
    fromChain: '1',
    toChain: '42161',
    tokenIn: { chain: '1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    tokenOut: { chain: '42161', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
    sender: source.privateExecutionAddress,
    recipient: destination.addresses[0].value,
    confidentiality: 'basic'
  }
  const authorize = (request, scope = account) =>
    assertPrivateQuoteRoute(request, account, 'private-cross-chain-withdraw', scope)
  expect(() => authorize(route)).not.toThrow()
  for (const changed of [
    { sender: source.addresses[0].value },
    { recipient: source.addresses[0].value },
    { recipient: destination.privateExecutionAddress },
    { toChain: route.fromChain, tokenOut: route.tokenIn, recipient: source.addresses[0].value },
    { tokenOut: { ...route.tokenOut, address: `0x${'5'.repeat(40)}`, symbol: 'USDC' } },
    {
      tokenIn: { ...route.tokenIn, isNative: true },
      tokenOut: { ...route.tokenOut, isNative: true }
    },
    { confidentiality: undefined }
  ])
    expect(() => authorize({ ...route, ...changed })).toThrow()
  expect(() => authorize(route, { ...account, accountId: 'account-2' })).toThrow(/account changed/)
  expect(() => assertPrivateQuoteRoute(route, account, 'private-transfer', account)).toThrow(
    /asset/
  )
})

test('alternative routes bind a fresh quote to the same account and selected build', async () => {
  const raw = {
    isCrossChain: true,
    chainType: 'zcash',
    bestQuote: {
      router: 'nearintents',
      amountOut: '2500',
      minAmountOut: '2400',
      expiresAt: 31_000,
      bridgeProvider: 'primary-bridge',
      preSwap: null,
      bridge: null
    },
    allQuotes: [
      {
        router: 'alternate',
        amountOut: '2300',
        minAmountOut: '2200',
        expiresAt: 20_000,
        bridgeProvider: 'alternate-bridge',
        preSwap: null,
        bridge: null
      },
      {
        router: 'two-step',
        amountOut: '3000',
        minAmountOut: '2900',
        requiresDestinationSwap: true
      }
    ]
  }
  let now = 2_000
  let nextHandle = 0
  let buildRequest = null
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const service = new RheaSwapService(
    {
      async quote(request) {
        return normalizeQuote(request, raw, 1_000)
      },
      async buildSwap({ quote }) {
        buildRequest = createSwapBuildRequest(quote)
        return {
          executionId: 'selected-route',
          isCrossChain: true,
          fromChain: quote.fromChain,
          toChain: quote.toChain,
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          amountIn: quote.amountIn,
          estimatedOut: quote.estimatedOut,
          minAmountOut: quote.minAmountOut,
          router: quote.buildContext.router,
          execution: {
            kind: 'zcash-transfer',
            chain: 'zcash',
            amount: quote.amountIn,
            depositAddress: 't1deposit',
            decimals: 8
          },
          request: buildRequest,
          raw: {}
        }
      }
    },
    sessions,
    { now: () => now, createHandle: () => `route-${++nextHandle}` }
  )
  const scope = { walletId: 'wallet-1', accountId: 'account-1', purpose: 'wallet-swap' }
  const best = await service.quote(quoteRequest, undefined, scope)
  expect(best.alternatives).toMatchObject([{ index: 1, router: 'alternate' }])
  expect(() =>
    parseTrustedExtensionRuntimeMessage({
      type: 'SELECT_RHEA_SWAP_ROUTE',
      quoteHandle: best.quoteHandle,
      routeIndex: 0
    })
  ).toThrow()
  expect(
    parseTrustedExtensionRuntimeMessage({
      type: 'SELECT_RHEA_SWAP_ROUTE',
      quoteHandle: best.quoteHandle,
      routeIndex: 1
    })
  ).toMatchObject({ routeIndex: 1 })
  await expect(service.selectRoute(best.quoteHandle, 2)).rejects.toThrow(/unavailable/)
  const selected = await service.selectRoute(best.quoteHandle, 1)
  expect(selected).toMatchObject({
    quoteHandle: 'rhea-quote:route-2',
    router: 'alternate',
    estimatedOut: '2300',
    expiresAt: 20_000,
    alternatives: [{ router: 'nearintents', estimatedOut: '2500' }]
  })
  const selectedContext = await service.readQuoteSecurityContext(selected.quoteHandle)
  expect(selectedContext.scope).toEqual(scope)
  expect(await service.readQuoteView(selected.quoteHandle)).toEqual(selected)
  expect(() =>
    assertPrivateQuoteRoute(
      selectedContext.request,
      { walletId: 'wallet-2', accountId: 'account-2', networks: [] },
      'wallet-swap',
      selectedContext.scope
    )
  ).toThrow(/account changed/)
  const review = await service.prepare(selected.quoteHandle)
  expect(review.router).toBe('alternate')
  expect(parseRheaSwapReviewView(review).alternatives).toEqual(review.alternatives)
  expect(() =>
    parseRheaSwapReviewView({
      ...review,
      alternatives: [{ ...review.alternatives[0], index: 0 }]
    })
  ).toThrow(/alternative index/)
  expect(buildRequest).toMatchObject({
    router: 'alternate',
    bridgeProvider: 'alternate-bridge',
    enableDestinationSwap: false
  })
  now = 20_001
  await expect(service.readQuoteView(selected.quoteHandle)).rejects.toThrow(/expired/)
  await expect(service.prepare(selected.quoteHandle)).rejects.toThrow(/expired/)
  await expect(service.selectRoute(best.quoteHandle, 1)).rejects.toThrow(/expired/)
})

test('Private Swap quote remains bound to the same Account and its managed destinations', () => {
  const source = `0x${'1'.repeat(40)}`
  const destination = `0x${'2'.repeat(40)}`
  const account = {
    walletId: 'wallet-1',
    accountId: 'account-1',
    networks: [
      {
        chainId: 'eip155:1',
        privateExecutionAddress: source,
        addresses: [{ value: `0x${'4'.repeat(40)}` }]
      },
      {
        chainId: 'eip155:56',
        privateExecutionAddress: destination,
        addresses: [{ value: `0x${'6'.repeat(40)}` }]
      }
    ]
  }
  const route = {
    fromChain: '1',
    toChain: '56',
    sender: source,
    recipient: destination,
    tokenIn: { address: 'native' },
    tokenOut: { address: 'native' }
  }
  expect(() => assertPrivateQuoteRoute(route, account, 'private-swap', account)).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, confidentiality: 'basic' },
      account,
      'private-swap',
      account
    )
  ).toThrow(/account changed/)
  const publicDestination = account.networks[1].addresses[0].value
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, recipient: publicDestination },
      account,
      'private-swap',
      account
    )
  ).toThrow(/this Account/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, recipient: publicDestination },
      {
        ...account,
        networks: [
          account.networks[0],
          { chainId: 'eip155:56', addresses: [{ value: publicDestination }] }
        ]
      },
      'private-swap',
      account
    )
  ).toThrow(/this Account/)
  const publicSource = account.networks[0].addresses[0].value
  const publicSwap = {
    ...route,
    sender: publicSource,
    recipient: publicDestination,
    confidentiality: undefined
  }
  expect(() => assertPrivateQuoteRoute(publicSwap, account, 'wallet-swap', account)).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, recipient: destination },
      account,
      'wallet-swap',
      account
    )
  ).toThrow(/Swap/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, recipient: `0x${'3'.repeat(40)}` },
      account,
      'wallet-swap',
      account
    )
  ).toThrow(/Swap/)
  const zcashAccount = {
    ...account,
    networks: [
      ...account.networks,
      {
        chainId: getZcashChainId('mainnet'),
        addresses: [{ value: 't1own' }, { value: 'u1own' }]
      }
    ]
  }
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, toChain: 'zcash', recipient: 'u1own' },
      zcashAccount,
      'private-swap',
      account
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, toChain: 'zcash', recipient: 't1own' },
      zcashAccount,
      'private-swap',
      account
    )
  ).toThrow(/this Account/)
  for (const recipient of ['u1external', 'U1OWN']) {
    expect(() =>
      assertPrivateQuoteRoute(
        { ...route, toChain: 'zcash', recipient },
        zcashAccount,
        'private-swap',
        account
      )
    ).toThrow(/this Account/)
  }
  expect(() =>
    assertPrivateQuoteRoute(
      {
        ...publicSwap,
        fromChain: 'zcash',
        sender: 't1own',
        recipient: destination,
        confidentiality: 'basic'
      },
      zcashAccount,
      'wallet-swap',
      account
    )
  ).toThrow(/Swap/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, fromChain: 'zcash', sender: 'u1own', recipient: publicDestination },
      zcashAccount,
      'wallet-swap',
      { ...account, zcashFundingSource: 'shielded' }
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, fromChain: 'zcash', sender: 't1own', recipient: publicDestination },
      zcashAccount,
      'wallet-swap',
      account
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, toChain: 'zcash', recipient: 'u1own' },
      zcashAccount,
      'wallet-swap',
      account
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, fromChain: 'zcash', sender: 'u1own' },
      zcashAccount,
      'private-swap',
      { ...account, zcashFundingSource: 'shielded' }
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, fromChain: 'zcash', sender: 'u1own', recipient: publicDestination },
      zcashAccount,
      'private-swap',
      { ...account, zcashFundingSource: 'shielded' }
    )
  ).toThrow(/this Account/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...route, fromChain: 'zcash', sender: 'u1own' },
      zcashAccount,
      'private-swap',
      { ...account, accountId: 'another-account', zcashFundingSource: 'shielded' }
    )
  ).toThrow(/account changed/)
  for (const sender of ['t1own', 'u1external']) {
    expect(() =>
      assertPrivateQuoteRoute(
        { ...route, fromChain: 'zcash', sender },
        zcashAccount,
        'private-swap',
        { ...account, zcashFundingSource: 'shielded' }
      )
    ).toThrow(/source/)
  }
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, toChain: 'zcash', recipient: 't1own' },
      zcashAccount,
      'wallet-swap',
      account
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, toChain: 'zcash', recipient: 'u1external' },
      zcashAccount,
      'wallet-swap',
      account
    )
  ).toThrow(/Swap/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, toChain: 'zcash', recipient: 'U1OWN' },
      zcashAccount,
      'wallet-swap',
      account
    )
  ).toThrow(/Swap/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, recipient: `0x${'3'.repeat(40)}` },
      account,
      'public-cross-chain-send',
      account
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, toChain: '1', recipient: `0x${'3'.repeat(40)}` },
      account,
      'public-cross-chain-send',
      account
    )
  ).toThrow(/Send route/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, recipient: destination, confidentiality: 'basic' },
      account,
      'confidential-funding',
      account
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicSwap, confidentiality: 'basic' },
      account,
      'confidential-funding',
      account
    )
  ).toThrow(/funding/)
  expect(() =>
    assertPrivateQuoteRoute({ ...route, recipient: undefined }, account, 'private-swap')
  ).toThrow(/this Account/)
  expect(() =>
    assertPrivateQuoteRoute({ ...route, recipient: `0x${'3'.repeat(40)}` }, account, 'private-swap')
  ).toThrow(/this Account/)
  expect(() =>
    assertPrivateQuoteRoute(route, account, 'private-swap', { ...account, accountId: 'account-2' })
  ).toThrow(/account changed/)
  expect(() => assertPrivateQuoteRoute(route, null, 'private-swap')).toThrow(/account changed/)
  const confidentialRoute = { ...route, confidentiality: 'basic' }
  const main = account.networks[0].addresses[0].value
  expect(() =>
    assertPrivateQuoteRoute(
      { ...confidentialRoute, toChain: '1', recipient: main },
      account,
      'private-transfer'
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...confidentialRoute, toChain: '1', recipient: `0x${'5'.repeat(40)}` },
      account,
      'private-transfer'
    )
  ).toThrow(/must stay in this Account/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...confidentialRoute, toChain: '1', recipient: main, tokenOut: { address: 'other' } },
      account,
      'private-transfer'
    )
  ).toThrow(/asset/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...confidentialRoute, recipient: `0x${'5'.repeat(40)}` },
      account,
      'private-cross-chain-send'
    )
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...confidentialRoute, toChain: '1', recipient: main },
      account,
      'private-cross-chain-send'
    )
  ).toThrow(/route is invalid/)
  const privateDappRoute = {
    ...confidentialRoute,
    toChain: '1',
    recipient: `0x${'5'.repeat(40)}`
  }
  expect(() =>
    assertPrivateQuoteRoute(privateDappRoute, account, 'private-dapp-transfer')
  ).not.toThrow()
  expect(() =>
    assertPrivateQuoteRoute(
      { ...privateDappRoute, tokenOut: { address: 'other' } },
      account,
      'private-dapp-transfer'
    )
  ).toThrow(/route is invalid/)
  const publicRoute = {
    ...confidentialRoute,
    toChain: '1',
    sender: main,
    recipient: `0x${'5'.repeat(40)}`
  }
  expect(() => assertPrivateQuoteRoute(publicRoute, account, 'public-private-send')).not.toThrow()
  const publicZcash = {
    ...quoteRequest,
    fromChain: 'zcash',
    toChain: 'zcash',
    tokenOut: sourceAsset,
    sender: `t1${'A'.repeat(33)}`,
    recipient: `t1${'B'.repeat(33)}`,
    confidentiality: 'basic'
  }
  const publicZcashAccount = {
    ...account,
    networks: [{ chainId: getZcashChainId('mainnet'), addresses: [{ value: publicZcash.sender }] }]
  }
  expect(() =>
    assertPrivateQuoteRoute(publicZcash, publicZcashAccount, 'public-private-send')
  ).not.toThrow()
  for (const changed of [
    { sender: `t1${'C'.repeat(33)}` },
    { recipient: `u1${'q'.repeat(80)}` },
    { recipient: `tm${'B'.repeat(33)}` },
    { toChain: 'near' },
    { tokenOut: destinationAsset },
    { confidentiality: undefined }
  ]) {
    expect(() =>
      assertPrivateQuoteRoute(
        { ...publicZcash, ...changed },
        publicZcashAccount,
        'public-private-send'
      )
    ).toThrow()
  }
  expect(() =>
    assertPrivateQuoteRoute(
      publicZcash,
      { ...publicZcashAccount, accountId: 'other' },
      'public-private-send',
      publicZcashAccount
    )
  ).toThrow(/account changed/)

  expect(() =>
    assertPrivateQuoteRoute({ ...publicRoute, sender: source }, account, 'public-private-send')
  ).toThrow(/route is invalid/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicRoute, confidentiality: undefined },
      account,
      'public-private-send'
    )
  ).toThrow(/account changed/)
  expect(() =>
    assertPrivateQuoteRoute(
      { ...publicRoute, tokenOut: { address: 'other' } },
      account,
      'public-private-send'
    )
  ).toThrow(/route is invalid/)
  expect(() =>
    assertPrivateQuoteRoute(
      publicRoute,
      { ...account, accountId: 'other' },
      'public-private-send',
      account
    )
  ).toThrow(/account changed/)
})

test('RHEA Swap quote sends the Noir Swap referral', () => {
  const request = toRheaSwapProtocolRequest(parseRheaSwapQuoteRequest(quoteRequest))
  expect(serializeQuoteRequest(request)).toMatchObject({ referral: 'noir_swap' })
})

test('Zcash unified source quotes bind the shielded funding source', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const request = { ...quoteRequest, sender: 'u1own' }
  const service = new RheaSwapService(
    {
      async quote(normalizedRequest) {
        return normalizeQuote(
          normalizedRequest,
          {
            isCrossChain: true,
            chainType: 'zcash',
            bestQuote: {
              router: 'nearintents',
              amountOut: '2500',
              minAmountOut: '2400',
              expiresAt: 31_000,
              preSwap: null,
              bridge: null
            }
          },
          1_000
        )
      }
    },
    sessions,
    { createHandle: () => 'unified-source' }
  )
  const scope = {
    walletId: 'wallet-1',
    accountId: 'account-1',
    purpose: 'private-swap',
    zcashFundingSource: 'shielded'
  }
  const quote = await service.quote(request, undefined, scope)
  await expect(service.readQuoteSecurityContext(quote.quoteHandle)).resolves.toMatchObject({
    scope,
    request: { sender: 'u1own' }
  })
  for (const purpose of ['wallet-swap', 'private-swap']) {
    await expect(
      service.quote(request, undefined, {
        ...scope,
        purpose,
        zcashFundingSource: 'transparent'
      })
    ).rejects.toThrow(/funding source/)
  }
  await expect(
    service.quote(request, undefined, {
      ...scope,
      purpose: 'wallet-swap',
      zcashFundingSource: undefined
    })
  ).rejects.toThrow(/funding source/)
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
    assetId: 'nep141:bnb.omdep.near',
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
    assetId: 'nep141:bnb.omdep.near',
    rheaAddress: '0x0000000000000000000000000000000000000000'
  })
})

test('prepared BNB swaps accept native address aliases while binding the custom ERC-20 contract', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const quoteHandle = 'rhea-quote:bnb-custom-token'
  const tokenOut = `0x${'a'.repeat(40)}`
  const request = toRheaSwapProtocolRequest(
    parseRheaSwapQuoteRequest({
      fromChain: '56',
      toChain: '56',
      tokenIn: {
        chain: '56',
        address: 'nep141:bnb.omdep.near',
        symbol: 'BNB',
        decimals: 18,
        isNative: true
      },
      tokenOut: { chain: '56', address: tokenOut, symbol: 'CUSTOM', decimals: 18 },
      amountIn: '1000000000000000',
      slippageBps: 50,
      sender: `0x${'1'.repeat(40)}`,
      recipient: `0x${'2'.repeat(40)}`
    })
  )
  const rawQuote = {
    isCrossChain: false,
    chainType: 'evm',
    bestQuote: {
      router: 'rango',
      amountOut: '2500000000000000000',
      minAmountOut: '2400000000000000000'
    }
  }
  const quote = normalizeQuote(request, rawQuote, 1_000)
  const rawBuild = {
    isCrossChain: false,
    chainType: 'evm',
    router: 'rango',
    fromChain: '56',
    toChain: '56',
    tokenIn: {
      address: '0x0000000000000000000000000000000000000000',
      symbol: 'BNB',
      decimals: 18
    },
    tokenOut: { address: tokenOut, symbol: 'CUSTOM', decimals: 18 },
    amountIn: quote.amountIn,
    estimatedOut: quote.estimatedOut,
    minAmountOut: quote.minAmountOut,
    tx: {
      chainId: 56,
      from: request.sender,
      to: `0x${'3'.repeat(40)}`,
      data: '0x1234',
      value: quote.amountIn
    },
    approve: null
  }
  const record = {
    schemaVersion: 1,
    quoteHandle,
    request,
    quoteRaw: rawQuote,
    receivedAt: 1_000,
    expiresAt: 31_000,
    build: {
      executionId: 'execution-bnb',
      request: {
        ...quote.buildContext.request,
        router: 'rango',
        expectedOut: quote.estimatedOut,
        minAmountOut: quote.minAmountOut
      },
      raw: rawBuild
    }
  }
  await sessions.put(record)
  const service = new RheaSwapService({}, sessions, { now: () => 2_000 })
  await expect(service.readPreparedBuild(quoteHandle)).resolves.toMatchObject({
    tokenIn: { address: rawBuild.tokenIn.address },
    tokenOut: { address: tokenOut }
  })
  await sessions.put({
    ...record,
    build: {
      ...record.build,
      raw: {
        ...rawBuild,
        tokenIn: { ...rawBuild.tokenIn, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }
      }
    }
  })
  await expect(service.readPreparedBuild(quoteHandle)).resolves.toMatchObject({
    tokenIn: { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }
  })
  await sessions.put({
    ...record,
    build: {
      ...record.build,
      raw: { ...rawBuild, router: 'rango-updated' }
    }
  })
  await expect(service.readPreparedBuild(quoteHandle)).resolves.toMatchObject({
    router: 'rango-updated'
  })
  await sessions.put({
    ...record,
    build: {
      ...record.build,
      raw: {
        ...rawBuild,
        tokenOut: { ...rawBuild.tokenOut, address: `0x${'4'.repeat(40)}` }
      }
    }
  })
  await expect(service.readPreparedBuild(quoteHandle)).rejects.toThrow(/does not match its quote/)
})

test('cross-chain Withdraw rejects a non-cross-chain build when reading the signing plan', async () => {
  const native = '0x0000000000000000000000000000000000000000'
  const request = {
    fromChain: '1',
    toChain: '42161',
    tokenIn: { chain: '1', address: native, decimals: 18, isNative: true },
    tokenOut: { chain: '42161', address: native, decimals: 18, isNative: true },
    amountIn: '100000000000000',
    slippageBps: 50,
    sender: `0x${'1'.repeat(40)}`,
    recipient: `0x${'2'.repeat(40)}`,
    confidentiality: 'basic'
  }
  const quoteRaw = {
    isCrossChain: true,
    chainType: 'evm',
    bestQuote: {
      router: 'nearintents',
      amountOut: '99000000000000',
      minAmountOut: '98000000000000'
    }
  }
  const quote = normalizeQuote(request, quoteRaw, 1_000)
  const rawBuild = {
    isCrossChain: true,
    chainType: 'evm',
    router: 'nearintents',
    fromChain: request.fromChain,
    toChain: request.toChain,
    tokenIn: { address: native, symbol: 'ETH', decimals: 18 },
    tokenOut: { address: native, symbol: 'ETH', decimals: 18 },
    amountIn: quote.amountIn,
    estimatedOut: quote.estimatedOut,
    minAmountOut: quote.minAmountOut,
    tx: {
      chainId: 1,
      from: request.sender,
      to: `0x${'3'.repeat(40)}`,
      data: '0x1234',
      value: quote.amountIn
    },
    approve: null
  }
  const record = {
    schemaVersion: 1,
    quoteHandle: 'rhea-quote:withdraw-plan',
    request,
    privateSwapScope: {
      walletId: 'wallet-1',
      accountId: 'account-1',
      purpose: 'private-cross-chain-withdraw'
    },
    quoteRaw,
    receivedAt: 1_000,
    expiresAt: 31_000,
    build: {
      executionId: 'withdraw-execution',
      request: createSwapBuildRequest(quote),
      raw: rawBuild
    }
  }
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const service = new RheaSwapService({}, sessions, { now: () => 2_000 })
  await sessions.put(record)
  await expect(service.readEvmTransactionPlan(record.quoteHandle)).resolves.toMatchObject({
    transaction: { chainId: 1, from: request.sender }
  })
  await sessions.put({
    ...record,
    build: { ...record.build, raw: { ...rawBuild, isCrossChain: false } }
  })
  await expect(service.readEvmTransactionPlan(record.quoteHandle)).rejects.toThrow(
    /chain does not match/
  )
})

test('prioritizes the persisted Intents order and only falls back to order-level evidence', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const quoteHandle = 'rhea-quote:intents-source-receipt'
  const sourceHash = `0x${'ab'.repeat(32)}`
  const destinationHash = `0x${'cd'.repeat(32)}`
  const sourceReceipt = { status: 'SUCCESS', provider: 'evm_receipt', toHash: sourceHash }
  const order = { orderId: 'intents-order', router: 'preswap-nearintents', chainId: '56' }
  const submission = {
    recordId: '14992',
    orderId: order.orderId,
    router: order.router,
    statusChainId: order.chainId,
    sourceHash
  }
  const record = {
    schemaVersion: 1,
    quoteHandle,
    request: toRheaSwapProtocolRequest(quoteRequest),
    submission
  }
  await sessions.put(record)
  let orderStatus = { status: 'PROCESSING' }
  let recordStatus = sourceReceipt
  let recordReads = 0
  const service = new RheaSwapService(
    {
      async getOrderStatusRaw(request) {
        if ('recordId' in request) {
          recordReads++
          return recordStatus
        }
        expect(request).toEqual(order)
        if (orderStatus instanceof Error) throw orderStatus
        return orderStatus
      }
    },
    sessions
  )

  await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
    status: 'processing',
    destinationHash: null
  })
  recordStatus = { status: 'SUCCESS', toHash: destinationHash }
  for (const status of ['PROCESSING', 'SUCCESS']) {
    orderStatus = { status }
    await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
      status: 'completed',
      destinationHash
    })
  }
  expect(recordReads).toBe(3)
  orderStatus = { status: 'SUCCESS', toHash: destinationHash }
  await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
    status: 'completed',
    destinationHash
  })
  expect(recordReads).toBe(3)
  orderStatus = new Error('Order status unavailable')
  recordStatus = { status: 'SUCCESS', toHash: sourceHash }
  await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
    status: 'pending',
    destinationHash: null
  })
  recordStatus = { status: 'SUCCESS', toHash: destinationHash }
  await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
    status: 'completed',
    destinationHash
  })
  recordStatus = sourceReceipt
  orderStatus = sourceReceipt
  await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
    status: 'pending',
    destinationHash: null
  })
  await sessions.put({ ...record, submission: { ...submission, orderId: null } })
  await expect(service.getOrderStatus(quoteHandle)).resolves.toMatchObject({
    status: 'pending',
    destinationHash: null
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
    deposit: { depositAddress: 't1deposit', timeEstimate: '35' },
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
        deposit: rawBuild.deposit,
        request: { ...buildRequest, recipient: buildRecipient },
        raw: rawBuild
      }
    },
    async reportRaw(request) {
      calls.push(['report', request])
      throw new Error('Legacy confidential receipts must not be reported to CrossChain DEX')
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
  await expect(
    replacedBuildService.readQuoteSecurityContext(replacedBuildQuote.quoteHandle)
  ).resolves.toMatchObject({
    scope: null
  })
  buildRecipient = 'attacker.near'
  await expect(replacedBuildService.prepare(replacedBuildQuote.quoteHandle)).rejects.toThrow(
    /does not match its quote/
  )
  buildRecipient = 'alice.near'
  for (const field of ['estimatedOut', 'minAmountOut']) {
    const updatedAmount =
      field === 'estimatedOut'
        ? (BigInt(quote.estimatedOut) + 1n).toString()
        : (BigInt(quote.minAmountOut) - 1n).toString()
    const driftedBuildService = new RheaSwapService(
      {
        ...client,
        async buildSwap(input) {
          const build = await client.buildSwap(input)
          return {
            ...build,
            [field]: updatedAmount,
            raw: { ...build.raw, [field]: updatedAmount }
          }
        }
      },
      new MemoryRheaSwapQuoteSessionStore(),
      { now: () => 2_000, createHandle: () => `drifted-${field}` }
    )
    const driftedQuote = await driftedBuildService.quote(confidentialQuoteRequest)
    const review = await driftedBuildService.prepare(driftedQuote.quoteHandle)
    expect(review[field]).toBe(updatedAmount)
    expect(review[field]).not.toBe(driftedQuote[field])
    await expect(
      driftedBuildService.readPreparedBuild(driftedQuote.quoteHandle)
    ).resolves.toMatchObject({
      [field]: updatedAmount
    })
  }
  for (const [field, invalidAmount] of [
    ['estimatedOut', '1'],
    ['minAmountOut', '0']
  ]) {
    const invalidBuildService = new RheaSwapService(
      {
        ...client,
        async buildSwap(input) {
          const build = await client.buildSwap(input)
          return { ...build, [field]: invalidAmount }
        }
      },
      new MemoryRheaSwapQuoteSessionStore(),
      { now: () => 2_000, createHandle: () => `invalid-${field}` }
    )
    const invalidQuote = await invalidBuildService.quote(confidentialQuoteRequest)
    await expect(invalidBuildService.prepare(invalidQuote.quoteHandle)).rejects.toThrow(
      /does not match its quote \(output\)/
    )
  }
  for (const field of ['tokenIn', 'tokenOut']) {
    const driftedBuildService = new RheaSwapService(
      {
        ...client,
        async buildSwap(input) {
          const build = await client.buildSwap(input)
          return {
            ...build,
            [field]: { ...build[field], decimals: build[field].decimals + 1 },
            raw: {
              ...build.raw,
              [field]: { ...build.raw[field], decimals: build.raw[field].decimals + 1 }
            }
          }
        }
      },
      new MemoryRheaSwapQuoteSessionStore(),
      { now: () => 2_000, createHandle: () => `drifted-${field}` }
    )
    const driftedQuote = await driftedBuildService.quote(confidentialQuoteRequest)
    await expect(driftedBuildService.prepare(driftedQuote.quoteHandle)).rejects.toThrow(
      /does not match its quote/
    )
  }
  let now = 2_000
  const service = new RheaSwapService(client, sessions, {
    now: () => now,
    createHandle: () => 'fixed'
  })
  const privateSwapScope = { walletId: 'wallet-1', accountId: 'account-1' }
  const quoteView = await service.quote(confidentialQuoteRequest, undefined, privateSwapScope)
  expect(quoteView.quoteHandle).toBe('rhea-quote:fixed')
  await expect(sessions.get(quoteView.quoteHandle)).resolves.toMatchObject({
    request: { confidentiality: 'basic' }
  })
  const review = await service.prepare(quoteView.quoteHandle)
  expect(review.execution).toMatchObject({ kind: 'zcash-transfer', target: 't1deposit' })
  expect(parseRheaSwapReviewView(review).timeEstimateSeconds).toBe(35)
  await expect(service.hasRecordedOrder(quoteView.quoteHandle)).resolves.toBe(false)
  expect((await service.readPreparedBuild(quoteView.quoteHandle)).executionId).toBe('execution-1')
  const depositTransfer = { executionId: 'execution-1', to: 't1deposit', amountZats: '100000000' }
  await expect(
    service.readZcashTransferDeadline(quoteView.quoteHandle, depositTransfer)
  ).resolves.toBe(31_000)
  const walletSwapService = new RheaSwapService(client, new MemoryRheaSwapQuoteSessionStore(), {
    now: () => 2_000,
    createHandle: () => 'wallet-swap-source'
  })
  const walletSwapQuote = await walletSwapService.quote(confidentialQuoteRequest, undefined, {
    ...privateSwapScope,
    purpose: 'wallet-swap'
  })
  await walletSwapService.prepare(walletSwapQuote.quoteHandle)
  await expect(
    walletSwapService.readZcashTransferDeadline(walletSwapQuote.quoteHandle, {
      ...depositTransfer,
      fundingSource: 'shielded'
    })
  ).rejects.toThrow(/funding source/)
  await expect(
    walletSwapService.readZcashTransferDeadline(walletSwapQuote.quoteHandle, depositTransfer)
  ).rejects.toThrow(/funding source/)
  await expect(
    walletSwapService.readZcashTransferDeadline(walletSwapQuote.quoteHandle, {
      ...depositTransfer,
      fundingSource: 'transparent'
    })
  ).resolves.toBe(31_000)
  await expect(
    walletSwapService.quote(confidentialQuoteRequest, undefined, {
      ...privateSwapScope,
      purpose: 'wallet-swap',
      zcashFundingSource: 'shielded'
    })
  ).rejects.toThrow(/funding source/)
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
  const restored = new RheaSwapService(client, sessions, { now: () => 40_000 })
  await expect(restored.hasRecordedOrder(quoteView.quoteHandle)).resolves.toBe(true)
  await expect(restored.readPrivateSwapRequest(quoteView.quoteHandle)).resolves.toMatchObject({
    scope: privateSwapScope,
    request: { recipient: 'alice.near' }
  })
  await expect(restored.readQuoteSecurityContext(quoteView.quoteHandle)).resolves.toMatchObject({
    scope: privateSwapScope
  })
  await expect(
    restored.recordTransactionSubmission(quoteView.quoteHandle, 'source-hash')
  ).resolves.toMatchObject({ sourceHash: 'source-hash' })
  await expect(restored.reportSubmission(quoteView.quoteHandle)).resolves.toMatchObject({
    sourceHash: 'source-hash',
    reportStatus: 'reported'
  })
  const afterReportRestart = new RheaSwapService(client, sessions, { now: () => 40_000 })
  await expect(afterReportRestart.getOrderStatus(quoteView.quoteHandle)).resolves.toMatchObject({
    orderId: 'order-1',
    status: 'completed',
    destinationHash: `0x${'ab'.repeat(32)}`
  })
  expect(calls).toEqual([['status', { orderId: 'order-1', router: 'nearintents' }]])

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

test('Solana v1 payloads are rejected before a signing plan is returned', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const request = {
    ...quoteRequest,
    fromChain: 'solana',
    tokenIn: { chain: 'solana', address: '11111111111111111111111111111111', decimals: 9 },
    sender: '11111111111111111111111111111111'
  }
  const quote = normalizeQuote(
    request,
    {
      bestQuote: { router: 'nearintents', amountOut: '1000', minAmountOut: '900' }
    },
    1_000
  )
  const quoteHandle = 'rhea-quote:solana-v1'
  const service = new RheaSwapService({}, sessions, { now: () => 2_000 })
  for (const tx of [{ version: 'v1', transaction: 'AQAA' }, { transaction: 'gQAA' }]) {
    await sessions.put({
      schemaVersion: 1,
      quoteHandle,
      request,
      quoteRaw: quote.raw,
      receivedAt: 1_000,
      expiresAt: null,
      build: {
        executionId: 'solana-v1',
        request: createSwapBuildRequest(quote),
        raw: {
          isCrossChain: true,
          chainType: 'solana',
          fromChain: request.fromChain,
          toChain: request.toChain,
          tokenIn: { ...request.tokenIn, symbol: 'SOL' },
          tokenOut: request.tokenOut,
          router: 'nearintents',
          amountIn: request.amountIn,
          estimatedOut: '1000',
          minAmountOut: '900',
          tx: { format: 'base64', ...tx }
        }
      }
    })
    await expect(service.readSolanaTransactionPlan(quoteHandle)).rejects.toThrow(/Solana v1/)
  }
})

test('EVM plan accepts only an exact ERC-20 approval followed by its bound swap transaction', async () => {
  const sessions = new MemoryRheaSwapQuoteSessionStore()
  const sender = '0x52908400098527886E0F7030069857D2E4169EE7'
  const token = '0xaabbccddaabbccddaabbccddaabbccddaabbccdd'
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
    tokenIn: { address: `0x${token.slice(2).toUpperCase()}`, symbol: 'USDC', decimals: 6 },
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
  expect(() =>
    normalizeBuild(
      {
        ...raw,
        requiresDestinationSwap: true
      },
      'two-step',
      request
    )
  ).toThrow(/second transaction/)
  await expect(service.readEvmTransactionPlan('rhea-quote:evm')).resolves.toMatchObject({
    transaction: { chainId: 1, to: router, value: '0' },
    approval: { spender, amountRaw: amount.toString() }
  })

  const boundSession = await sessions.get('rhea-quote:evm')
  await sessions.put({
    ...boundSession,
    build: {
      ...boundSession.build,
      raw: {
        ...raw,
        tokenIn: { ...raw.tokenIn, address: '0x1111111111111111111111111111111111111111' }
      }
    }
  })
  await expect(service.readEvmTransactionPlan('rhea-quote:evm')).rejects.toThrow(
    /does not match its quote/
  )
  await sessions.put(boundSession)

  await sessions.put({
    ...boundSession,
    quoteRaw: {
      ...boundSession.quoteRaw,
      bestQuote: { ...boundSession.quoteRaw.bestQuote, router: 'cow', quoteId: 'quote-evm' }
    },
    build: {
      executionId: 'execution-evm',
      request: { ...request, router: 'cow', quoteId: 'quote-evm', enableDestinationSwap: false },
      raw: {
        ...raw,
        router: 'cow',
        executionType: 'signature',
        tx: null,
        signingRequest: {
          type: 'eip712',
          router: 'cow',
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
  const cowRecord = await sessions.get('rhea-quote:evm')
  for (const signingRequest of [
    { ...cowRecord.build.raw.signingRequest, quoteId: 'other-quote' },
    {
      ...cowRecord.build.raw.signingRequest,
      typedData: { ...cowRecord.build.raw.signingRequest.typedData, domain: { chainId: 56 } }
    }
  ]) {
    await sessions.put({
      ...cowRecord,
      build: { ...cowRecord.build, raw: { ...cowRecord.build.raw, signingRequest } }
    })
    await expect(service.readEvmSignaturePlan('rhea-quote:evm')).rejects.toThrow(
      /does not match its quote/
    )
  }
  await sessions.put(cowRecord)

  let submittedOrders = 0
  const submissionService = new RheaSwapService(
    {
      async submitOrderRaw(input) {
        expect(input).toMatchObject({
          router: 'cow',
          quoteId: 'quote-evm',
          signingScheme: 'eip712'
        })
        submittedOrders += 1
        await Promise.resolve()
        return { orderId: 'order-evm', router: 'cow', chainId: 1 }
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
    ...boundSession,
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
