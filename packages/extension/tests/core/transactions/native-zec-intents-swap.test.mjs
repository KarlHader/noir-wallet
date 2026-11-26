import { after, test } from 'node:test'
import { expect } from '@playwright/test'
import { zatsToZec, zecToZats } from '../../../src/core/services/native-zec-intents-swap.ts'

globalThis.location = {
  href: 'chrome-extension://test/src/background/index.js',
  pathname: '/src/background/index.js'
}
const emptyStorage = { get: async () => ({}) }
globalThis.chrome = {
  runtime: { id: 'test', getURL: path => `chrome-extension://test${path}` },
  storage: { local: emptyStorage, session: emptyStorage, onChanged: { addListener() {} } }
}
const {
  markNativeZecIntentsSwapTerminal,
  NativeZecIntentsSwapCoordinator,
  readNativeZecIntentsStatusViewer,
  readNativeZecIntentsSwapStatus
} = await import('../../../src/background/native-zec-intents-swap.ts')
const { ConfidentialFundingApi } =
  await import('../../../src/background/confidential-funding-api.ts')
after(() => {
  delete globalThis.chrome
  delete globalThis.location
})

test('native ZEC Intents spend binds the approved quote and survives coordinator recreation', async () => {
  const walletId = 'wallet-one'
  const accountId = 'account-one'
  const quoteId = 'quote-one'
  const refundAddress = `t1${'A'.repeat(33)}`
  const depositAddress = `t1${'B'.repeat(33)}`
  const oldShieldedAddress = `u1${'q'.repeat(55)}`
  const currentShieldedAddress = `u1${'p'.repeat(55)}`
  const shieldedOrder = {
    depositAddress,
    depositMemo: ' reference + & ',
    viewer: { chainFamily: 'zcash', walletAddress: refundAddress, signingMode: 'derived' }
  }
  const expiresAt = Date.now() + 600_000
  const destination = {
    chainId: 'eip155:1',
    assetId: 'eip155:1/slip44:60',
    protocolAssetId: 'nep141:eth.omft.near',
    recipient: '0x1111111111111111111111111111111111111111'
  }
  const quoteBinding = {
    provider: 'near-intents',
    quoteHandle: quoteId,
    isCrossChain: true,
    destinationChain: destination.chainId,
    depositAddress,
    originAsset: 'nep141:zec.omft.near',
    destinationAsset: destination.protocolAssetId,
    expectedAmountOut: '1000',
    minAmountOut: '900',
    recipient: destination.recipient,
    refundTo: refundAddress,
    deadline: expiresAt
  }
  const record = {
    schemaVersion: 1,
    quoteId,
    network: 'mainnet',
    walletId,
    accountId,
    amountZats: '125000000',
    amountZec: '1.25',
    depositAddress,
    destination,
    destinationBlockchain: 'eth',
    destinationSymbol: 'ETH',
    destinationDecimals: 18,
    refundAddress,
    expectedOutputRaw: '1000',
    minimumOutputRaw: '900',
    expiresAt,
    quoteBinding,
    slippageBps: 50,
    createdAt: Date.now()
  }
  expect(readNativeZecIntentsStatusViewer(quoteBinding, 'mainnet')).toEqual({
    chainFamily: 'zcash',
    walletAddress: refundAddress,
    signingMode: 'transparent'
  })
  expect(
    readNativeZecIntentsStatusViewer({ ...quoteBinding, refundTo: oldShieldedAddress }, 'mainnet')
  ).toBeUndefined()
  expect(
    readNativeZecIntentsStatusViewer(
      { ...quoteBinding, refundTo: oldShieldedAddress, oneClickOrder: shieldedOrder },
      'mainnet'
    )
  ).toEqual(shieldedOrder.viewer)
  const values = new Map([
    [`native_zec_intents_swap:${quoteId}`, structuredClone(record)],
    [
      'native_zec_intents_swap:quote-two',
      {
        ...structuredClone(record),
        quoteId: 'quote-two',
        quoteBinding: { ...quoteBinding, quoteHandle: 'quote-two' }
      }
    ],
    [
      'native_zec_intents_swap:quote-three',
      {
        ...structuredClone(record),
        schemaVersion: 2,
        quoteId: 'quote-three',
        recipientType: 'CONFIDENTIAL_INTENTS',
        fundingSource: 'transparent',
        quoteBinding: {
          ...quoteBinding,
          quoteHandle: 'quote-three',
          recipientType: 'CONFIDENTIAL_INTENTS',
          fundingSource: 'transparent'
        }
      }
    ],
    [
      'native_zec_intents_swap:quote-rotated',
      {
        ...structuredClone(record),
        quoteId: 'quote-rotated',
        refundAddress: oldShieldedAddress,
        quoteBinding: {
          ...quoteBinding,
          quoteHandle: 'quote-rotated',
          refundTo: oldShieldedAddress,
          oneClickOrder: shieldedOrder
        }
      }
    ],
    ['native_zec_intents_swap:index', [quoteId, 'quote-two', 'quote-three']]
  ])
  const previousChrome = globalThis.chrome
  const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  globalThis.chrome = {
    storage: {
      onChanged: { addListener: () => {} },
      local: {
        get: async key =>
          key === null
            ? Promise.reject(new Error('Full storage read is forbidden'))
            : Object.fromEntries(
                (Array.isArray(key) ? key : [key])
                  .filter(item => values.has(item))
                  .map(item => [item, structuredClone(values.get(item))])
              ),
        set: async entries => {
          for (const [key, value] of Object.entries(entries))
            values.set(key, structuredClone(value))
        },
        remove: async key => {
          for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
        }
      }
    }
  }
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: async (_name, operation) => operation() }
  })
  try {
    const options = {
      network: 'mainnet',
      assets: { get: () => undefined },
      evmNetworks: [],
      assetMappings: [],
      isUnlocked: async () => true,
      resolveConfidentialIdentity: async () => destination.recipient,
      getActiveAccount: () => ({
        network: 'mainnet',
        walletId,
        accountId,
        refundAddresses: [refundAddress, currentShieldedAddress],
        shieldedRefundAddressHistory: [oldShieldedAddress, currentShieldedAddress]
      })
    }
    const coordinator = new NativeZecIntentsSwapCoordinator(options)
    const lockedCoordinator = new NativeZecIntentsSwapCoordinator({
      ...options,
      isUnlocked: async () => false
    })
    const spend = {
      walletId,
      accountId,
      transactionId: 'transaction-one',
      binding: quoteBinding,
      to: depositAddress,
      amount: '1.25',
      fundingSource: 'shielded'
    }
    const rotatedQuote = await coordinator.get('quote-rotated')
    await expect(
      readNativeZecIntentsSwapStatus(rotatedQuote.quoteBinding, {
        network: 'mainnet',
        walletId,
        accountId: 'other-account'
      })
    ).rejects.toThrow('status quote binding changed')
    const rotatedSpend = {
      ...spend,
      transactionId: 'transaction-rotated',
      binding: structuredClone(rotatedQuote.quoteBinding)
    }
    const unrelatedCoordinator = new NativeZecIntentsSwapCoordinator({
      ...options,
      getActiveAccount: () => ({
        ...options.getActiveAccount(),
        shieldedRefundAddressHistory: []
      })
    })
    await expect(unrelatedCoordinator.claimSpend(rotatedSpend)).rejects.toThrow('not owned')
    for (const changedOrder of [
      { ...shieldedOrder, depositMemo: shieldedOrder.depositMemo.trim() },
      {
        ...shieldedOrder,
        viewer: { ...shieldedOrder.viewer, walletAddress: depositAddress }
      }
    ]) {
      await expect(
        coordinator.claimSpend({
          ...rotatedSpend,
          binding: { ...rotatedSpend.binding, oneClickOrder: changedOrder }
        })
      ).rejects.toThrow('quote changed')
    }
    await expect(coordinator.claimSpend(rotatedSpend)).resolves.toBe(expiresAt)
    await expect(coordinator.claimSpend({ ...spend, to: refundAddress })).rejects.toThrow()
    await expect(lockedCoordinator.get(quoteId)).rejects.toThrow('Wallet is locked')
    await expect(lockedCoordinator.claimSpend(spend)).rejects.toThrow('Wallet is locked')
    await expect(
      coordinator.claimSpend({ ...spend, fundingSource: 'transparent' })
    ).rejects.toThrow()
    await expect(
      coordinator.claimSpend({
        ...spend,
        binding: { ...quoteBinding, recipient: refundAddress }
      })
    ).rejects.toThrow()
    expect(await coordinator.claimSpend(spend)).toBe(expiresAt)
    expect(await coordinator.claimSpend(spend)).toBe(expiresAt)
    expect(values.get(`native_zec_intents_swap:${quoteId}`).claimedTransactionId).toBe(
      'transaction-one'
    )
    expect(await coordinator.cancel(quoteId)).toBe(false)
    expect(await coordinator.cancel('quote-two')).toBe(true)
    expect(values.get('native_zec_intents_swap:index')).toEqual([quoteId, 'quote-three'])
    const confidentialSpend = {
      ...spend,
      transactionId: 'transaction-three',
      binding: values.get('native_zec_intents_swap:quote-three').quoteBinding,
      fundingSource: 'transparent'
    }
    await expect(
      coordinator.claimSpend({ ...confidentialSpend, fundingSource: 'shielded' })
    ).rejects.toThrow()
    await expect(
      coordinator.claimSpend({
        ...confidentialSpend,
        binding: { ...confidentialSpend.binding, recipientType: 'DESTINATION_CHAIN' }
      })
    ).rejects.toThrow()
    const reorderedBinding = Object.fromEntries(Object.entries(confidentialSpend.binding).reverse())
    await expect(
      coordinator.claimSpend({
        ...confidentialSpend,
        binding: { ...reorderedBinding, minAmountOut: '899' }
      })
    ).rejects.toThrow()
    expect(await coordinator.claimSpend({ ...confidentialSpend, binding: reorderedBinding })).toBe(
      expiresAt
    )
    expect(await coordinator.claimSpend(confidentialSpend)).toBe(expiresAt)
    await expect(
      new NativeZecIntentsSwapCoordinator(options).claimSpend({
        ...spend,
        transactionId: 'transaction-two'
      })
    ).rejects.toThrow()
    const expiredAt = Date.now() - 26 * 60 * 60_000
    for (const id of [quoteId, 'quote-three']) {
      const key = `native_zec_intents_swap:${id}`
      const stored = values.get(key)
      values.set(key, {
        ...stored,
        expiresAt: expiredAt,
        quoteBinding: { ...stored.quoteBinding, deadline: expiredAt }
      })
    }
    const newRequest = {
      network: 'mainnet',
      walletId,
      accountId,
      amountZats: '1',
      destination,
      refundAddress,
      slippageBps: 50
    }
    await expect(coordinator.prepare(newRequest)).rejects.toThrow('Native ZEC asset is unavailable')
    expect(values.has(`native_zec_intents_swap:${quoteId}`)).toBe(false)
    expect(values.has('native_zec_intents_swap:quote-three')).toBe(true)
    const terminalBinding = values.get('native_zec_intents_swap:quote-three').quoteBinding
    await markNativeZecIntentsSwapTerminal(terminalBinding, 'transaction-three', 'SUCCESS')
    expect(values.get('native_zec_intents_swap:quote-three').terminalStatus).toBe('SUCCESS')
    const settled = values.get('native_zec_intents_swap:quote-three')
    values.set('native_zec_intents_swap:quote-three', { ...settled, terminalAt: expiredAt })
    await expect(coordinator.prepare(newRequest)).rejects.toThrow('Native ZEC asset is unavailable')
    expect(values.has('native_zec_intents_swap:quote-three')).toBe(false)
  } finally {
    globalThis.chrome = previousChrome
    if (previousLocks === undefined) delete globalThis.navigator.locks
    else Object.defineProperty(globalThis.navigator, 'locks', previousLocks)
  }
})

test('native ZEC conversion preserves exact zats', () => {
  expect(zatsToZec('125000001')).toBe('1.25000001')
  expect(zecToZats('1.25000001')).toBe('125000001')
  expect(() => zecToZats('1.000000001')).toThrow()
})

test('native ZEC Confidential destination binds the internal ZEC asset and active account', async () => {
  const chainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const assetId = `${chainId}/slip44:133`
  const protocolAssetId = 'nep141:zec.omft.near'
  const refundAddress = `t1${'A'.repeat(33)}`
  const depositAddress = `t1${'B'.repeat(33)}`
  const shieldedRefundAddress = `u1${'q'.repeat(55)}`
  const shieldedDepositAddress = `t1${'C'.repeat(33)}`
  const shieldedViewer = {
    chainFamily: 'zcash',
    walletAddress: `t1${'D'.repeat(33)}`,
    signingMode: 'derived'
  }
  const recipient = '0x1111111111111111111111111111111111111111'
  const destination = { chainId, assetId, protocolAssetId }
  const values = new Map()
  const quoteRequests = []
  let activeAccountId = 'account-one'
  let switchDuringAuthorization = false
  let switchDuringIdentityResolution = false
  let identityResolutionCount = 0
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  const originalLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  globalThis.chrome = {
    storage: {
      local: {
        get: async keys =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys])
              .filter(key => values.has(key))
              .map(key => [key, structuredClone(values.get(key))])
          ),
        set: async entries => {
          for (const [key, value] of Object.entries(entries))
            values.set(key, structuredClone(value))
        },
        remove: async keys => {
          for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
        }
      }
    }
  }
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: async (_name, operation) => operation() }
  })
  const oneClickApiUrl = 'https://example.test/proxy/1click/v0'
  const api = new ConfidentialFundingApi({ oneClickApiUrl }, '', '')
  globalThis.fetch = async (url, init) => {
    if (url === `${oneClickApiUrl}/quote`) {
      const quoteRequest = JSON.parse(init.body)
      quoteRequests.push(quoteRequest)
      return Response.json({
        code: 0,
        data: {
          correlationId: 'quote-one',
          quoteRequest,
          quote: {
            amountIn: quoteRequest.amount,
            amountOut: quoteRequest.amount,
            minAmountOut: quoteRequest.amount,
            ...(!quoteRequest.dry && {
              depositAddress:
                quoteRequest.refundTo === shieldedRefundAddress
                  ? shieldedDepositAddress
                  : depositAddress,
              depositMemo: ' ref+id '
            }),
            deadline: quoteRequest.deadline
          }
        }
      })
    }
    return Response.json([
      {
        assetId: protocolAssetId,
        blockchain: 'zec',
        decimals: 8,
        price: 1,
        priceUpdatedAt: new Date().toISOString(),
        symbol: 'ZEC'
      }
    ])
  }
  try {
    const coordinator = new NativeZecIntentsSwapCoordinator({
      network: 'mainnet',
      assets: {
        get: id => (id === assetId ? { metadata: { decimals: 8 } } : undefined)
      },
      evmNetworks: [],
      assetMappings: [{ assetId, protocolAssetId }],
      isUnlocked: async () => true,
      resolveOneClickViewer: async (_scope, address, refundSource) =>
        refundSource === 'shielded'
          ? shieldedViewer
          : { chainFamily: 'zcash', walletAddress: address, signingMode: 'transparent' },
      getActiveAccount: () => ({
        network: 'mainnet',
        walletId: 'wallet-one',
        accountId: activeAccountId,
        refundAddresses: [refundAddress],
        shieldedRefundAddressHistory: [shieldedRefundAddress]
      }),
      resolveConfidentialIdentity: async () => {
        identityResolutionCount += 1
        if (switchDuringIdentityResolution && identityResolutionCount === 2)
          activeAccountId = 'account-two'
        return recipient
      },
      authorizeConfidentialIdentity: async () => {
        if (switchDuringAuthorization) activeAccountId = 'account-two'
      },
      quoteConfidential: input =>
        api.quote({
          ...input,
          recipient: input.signerId,
          depositType: 'ORIGIN_CHAIN',
          refundType: 'ORIGIN_CHAIN',
          recipientType: 'CONFIDENTIAL_INTENTS',
          dry: false
        })
    })
    const request = {
      network: 'mainnet',
      walletId: 'wallet-one',
      accountId: 'account-one',
      amountZats: '100000000',
      destination,
      refundAddress,
      fundingSource: 'transparent',
      recipientType: 'CONFIDENTIAL_INTENTS',
      requestId: 'explicit-zec-confidential-swap',
      userAction: 'swap',
      slippageBps: 50
    }
    switchDuringAuthorization = true
    await expect(coordinator.prepare(request)).rejects.toThrow(
      'Native ZEC Intents Swap account changed'
    )
    expect(values.size).toBe(0)
    activeAccountId = 'account-one'
    switchDuringAuthorization = false
    switchDuringIdentityResolution = true
    identityResolutionCount = 0
    await expect(coordinator.prepare(request)).rejects.toThrow(
      'Native ZEC Intents Swap account changed'
    )
    expect(values.size).toBe(0)
    activeAccountId = 'account-one'
    switchDuringIdentityResolution = false
    const review = await coordinator.prepare(request)
    expect(review.destination).toEqual({ ...destination, recipient })
    expect(review.quoteBinding).toMatchObject({
      destinationChain: destination.chainId,
      destinationAsset: protocolAssetId,
      recipient,
      recipientType: 'CONFIDENTIAL_INTENTS',
      userAction: 'swap',
      oneClickOrder: {
        depositAddress,
        depositMemo: ' ref+id ',
        viewer: { chainFamily: 'zcash', walletAddress: refundAddress, signingMode: 'transparent' }
      }
    })
    expect(values.get(`native_zec_intents_swap:${review.quoteId}`).schemaVersion).toBe(2)
    expect(await coordinator.get(review.quoteId)).toMatchObject({
      quoteBinding: review.quoteBinding,
      appFeeBps: 2
    })
    await expect(coordinator.prepare({ ...request, userAction: undefined })).rejects.toThrow(
      'request ID was reused with different details'
    )
    await expect(
      coordinator.prepare({
        ...request,
        recipientType: 'DESTINATION_CHAIN',
        fundingSource: undefined,
        userAction: undefined,
        destination: { ...destination, recipient: refundAddress }
      })
    ).rejects.toThrow('Native ZEC Intents destination is invalid')
    const shieldedReview = await coordinator.prepare({
      ...request,
      refundAddress: shieldedRefundAddress,
      fundingSource: 'shielded',
      requestId: 'shielded-zec-confidential-swap'
    })
    const transparentQuote = quoteRequests.find(
      quote => !quote.dry && quote.refundTo === refundAddress
    )
    expect(transparentQuote).toMatchObject({
      referral: 'noir_swap',
      appFees: [{ recipient: 'noir_swap.near', fee: 2 }]
    })
    expect(transparentQuote).not.toHaveProperty('user')
    expect(transparentQuote).not.toHaveProperty('userChainFamily')
    expect(
      quoteRequests.find(quote => !quote.dry && quote.refundTo === shieldedRefundAddress)
    ).toMatchObject({
      referral: 'noir_swap',
      appFees: [{ recipient: 'noir_swap.near', fee: 2 }],
      refundType: 'ORIGIN_CHAIN',
      refundTo: shieldedRefundAddress,
      user: shieldedViewer.walletAddress,
      userChainFamily: 'zcash'
    })
    expect((await coordinator.get(shieldedReview.quoteId)).quoteBinding).toMatchObject({
      refundTo: shieldedRefundAddress,
      oneClickOrder: {
        depositAddress: shieldedDepositAddress,
        depositMemo: ' ref+id ',
        viewer: shieldedViewer
      }
    })
    expect(await coordinator.cancel(review.quoteId)).toBe(true)
    await coordinator.prepare({ ...request, userAction: undefined })
    expect(quoteRequests.at(-1)).toMatchObject({
      dry: false,
      referral: 'noir_receive',
      appFees: [{ recipient: 'noir_swap.near', fee: 2 }]
    })
  } finally {
    globalThis.chrome = originalChrome
    globalThis.fetch = originalFetch
    if (originalLocks === undefined) delete globalThis.navigator.locks
    else Object.defineProperty(globalThis.navigator, 'locks', originalLocks)
  }
})
