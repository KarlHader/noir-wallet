import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  ChromeConfidentialFundingStore,
  CONFIDENTIAL_BALANCE_CACHE_TTL_MS
} from '../../../src/background/confidential-funding-store.ts'

function storageArea() {
  const values = new Map()
  return {
    values,
    get: async key =>
      key === null
        ? Object.fromEntries(values)
        : Array.isArray(key)
          ? Object.fromEntries(
              key
                .filter(item => values.has(item))
                .map(item => [item, structuredClone(values.get(item))])
            )
          : values.has(key)
            ? { [key]: structuredClone(values.get(key)) }
            : {},
    set: async entries => {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value))
    },
    remove: async key => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
    }
  }
}

test('expires Confidential balance caches and treats legacy arrays as stale', async () => {
  let now = 10_000
  const local = storageArea()
  const session = storageArea()
  const previousChrome = globalThis.chrome
  globalThis.chrome = { storage: { local, session } }
  try {
    const store = new ChromeConfidentialFundingStore(() => now)
    const balances = [{ tokenId: 'nep141:usdc.omft.near', available: '42', source: 'intents' }]
    await store.putBalances('mainnet', 'wallet:one', 'account:one', balances)
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual(
      balances
    )

    now += CONFIDENTIAL_BALANCE_CACHE_TTL_MS + 1
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual([])

    const [key] = [...local.values.keys()]
    local.values.set(key, structuredClone(balances))
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual([])
    await store.putBalances('mainnet', 'wallet:one', 'account:one', balances)
    await store.putBalances('testnet', 'wallet:one', 'account:one', balances)
    await store.putBalances('mainnet', 'wallet:one', 'account:two', balances)
    await store.deleteBalancesByAccountScope('wallet:one', 'account:one')
    expect(await store.getBalances('mainnet', 'wallet:one', 'account:one')).toEqual([])
    expect(await store.getBalances('testnet', 'wallet:one', 'account:one')).toEqual([])
    expect(await store.getBalances('mainnet', 'wallet:one', 'account:two')).toEqual(balances)
  } finally {
    globalThis.chrome = previousChrome
  }
})

test('persists external Shield deposit quote bindings across a restart', async () => {
  const local = storageArea()
  const session = storageArea()
  const previousChrome = globalThis.chrome
  const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  globalThis.chrome = { storage: { local, session } }
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: async (_name, operation) => operation() }
  })
  try {
    const store = new ChromeConfidentialFundingStore()
    const signerId = '0x1111111111111111111111111111111111111111'
    const refundAddress = '0x2222222222222222222222222222222222222222'
    const depositAddress = '0x3333333333333333333333333333333333333333'
    const source = {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId: 'eip155:1/slip44:60',
      protocolAssetId: 'nep141:eth.omft.near',
      amountRaw: '1000'
    }
    const record = {
      schemaVersion: 1,
      depositId: 'one',
      transactionId: 'tx:confidential-external:one',
      network: 'mainnet',
      keyDomainId: 'wallet:one',
      accountId: 'account:one',
      source,
      destinationAssetId: source.assetId,
      sourceSymbol: 'ETH',
      sourceDecimals: 18,
      signerId,
      depositAddress,
      depositMemo: ' memo-1 ',
      refundAddress,
      amountRaw: '1000',
      expectedOutputRaw: '990',
      minimumOutputRaw: '980',
      slippageBps: 50,
      expiresAt: 60_000,
      phase: 'awaiting-payment',
      quote: {
        correlationId: 'quote-one',
        quoteRequest: {
          swapType: 'EXACT_INPUT',
          confidentiality: 'basic',
          slippageTolerance: 50,
          originAsset: source.protocolAssetId,
          destinationAsset: source.protocolAssetId,
          amount: '1000',
          refundTo: refundAddress,
          recipient: signerId,
          depositType: 'ORIGIN_CHAIN',
          refundType: 'ORIGIN_CHAIN',
          recipientType: 'CONFIDENTIAL_INTENTS'
        },
        quote: {
          amountIn: '1000',
          amountOut: '990',
          minAmountOut: '980',
          depositAddress,
          depositMemo: ' memo-1 ',
          deadline: new Date(60_000).toISOString()
        }
      },
      createdAt: 1000,
      updatedAt: 1000
    }
    await store.putExternalDeposit(record)
    expect(await new ChromeConfidentialFundingStore().getExternalDeposit('one')).toEqual(record)
    const partial = { ...record, fundingObservedAt: 2_000, providerStatus: 'EXPIRED' }
    await store.putExternalDeposit(partial)
    expect(await new ChromeConfidentialFundingStore().getExternalDeposit('one')).toEqual(partial)
    const key = [...local.values.keys()].find(value =>
      value.startsWith('confidential_external_deposit:')
    )
    for (const changed of [
      {
        quote: {
          ...record.quote,
          quoteRequest: { ...record.quote.quoteRequest, refundTo: signerId }
        }
      },
      { slippageBps: 100 },
      { expiresAt: 90_000 },
      { fundingObservedAt: -1 },
      { destinationAssetId: 'eip155:1/slip44:1' }
    ]) {
      local.values.set(key, { ...record, ...changed })
      await expect(store.getExternalDeposit('one')).rejects.toThrow(
        'Stored external Shield deposit is invalid'
      )
      expect(await store.listExternalDeposits()).toEqual([])
    }
    await store.putExternalDeposit(record)
    await store.deleteExternalDepositsByAccountScope('wallet:one', 'account:one')
    expect(await store.listExternalDeposits()).toEqual([])
    const auth = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 60_000,
      refreshExpiresAt: 120_000
    }
    await store.putSession('mainnet', 'wallet:one', 'account:one', auth)
    await store.putSession('testnet', 'wallet:one', 'account:one', auth)
    await store.putSession('mainnet', 'wallet:one', 'account:two', auth)
    await store.deleteSessionsByAccountScope('wallet:one', 'account:one')
    expect(await store.getSession('mainnet', 'wallet:one', 'account:one')).toBeNull()
    expect(await store.getSession('testnet', 'wallet:one', 'account:one')).toBeNull()
    expect(await store.getSession('mainnet', 'wallet:one', 'account:two')).toEqual(auth)
    await local.set({ wallet_deleted_ids: ['wallet:one'] })
    await expect(store.putExternalDeposit(record)).rejects.toThrow(
      'Wallet Account metadata is unavailable'
    )
    await expect(store.putSession('mainnet', 'wallet:one', 'account:one', auth)).rejects.toThrow(
      'Wallet Account metadata is unavailable'
    )
    let lateWriteRan = false
    await expect(
      store.withExternalDepositScope(record, async () => {
        lateWriteRan = true
      })
    ).rejects.toThrow('Wallet Account metadata is unavailable')
    expect(lateWriteRan).toBe(false)
    await local.set({
      wallet_deleted_ids: [],
      wallet_deleted_account_keys: ['mainnet_wallet:one_account:one']
    })
    await expect(store.putExternalDeposit(record)).rejects.toThrow(
      'Wallet Account metadata is unavailable'
    )
  } finally {
    globalThis.chrome = previousChrome
    if (previousLocks === undefined) delete globalThis.navigator.locks
    else Object.defineProperty(globalThis.navigator, 'locks', previousLocks)
  }
})
