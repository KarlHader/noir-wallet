import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildLiveSwapQuoteRequest,
  isSwapSourceAmountInsufficient,
  resolveSwapExecutionSourceMode,
  resolveSwapStatusPollingProvider,
  resolveWalletSwapSourceAvailableRaw
} from '../../../src/popup/services/swap-page-model.ts'

test('compares Swap input with the active source availability', () => {
  const input = {
    isZecSource: false,
    amount: '0.9',
    amountRaw: '900',
    sourceAvailableRaw: '850',
    sourceSelected: true,
    zcashAvailable: '0'
  }
  expect(isSwapSourceAmountInsufficient(input)).toBe(true)
  expect(isSwapSourceAmountInsufficient({ ...input, sourceAvailableRaw: '900' })).toBe(false)
  expect(isSwapSourceAmountInsufficient({ ...input, sourceAvailableRaw: null })).toBe(true)
  expect(
    isSwapSourceAmountInsufficient({
      ...input,
      isZecSource: true,
      amount: '0.9',
      zcashAvailable: '0.8'
    })
  ).toBe(true)
})

const quoteToken = Object.freeze({
  assetId: 'nep141:eth.omft.near',
  blockchain: 'eth',
  decimals: 18,
  price: 1,
  priceUpdatedAt: new Date(0).toISOString(),
  symbol: 'ETH',
  rheaChainId: '1',
  tokenListChainId: 1,
  rheaAddress: '0x0000000000000000000000000000000000000000',
  isNative: true
})

test('routes RHEA Swap results only through the quote-handle monitor', () => {
  expect(
    resolveSwapStatusPollingProvider({
      depositAddress: 'rhea-deposit-address',
      rheaQuoteHandle: 'quote-handle'
    })
  ).toBe('rhea-swap')
})

test('keeps legacy NEAR Intents status polling for deposit-only results', () => {
  expect(resolveSwapStatusPollingProvider({ depositAddress: 'intents-deposit-address' })).toBe(
    'near-intents'
  )
  expect(resolveSwapStatusPollingProvider({})).toBeNull()
})

test('uses the selected EVM account balance for swap availability', () => {
  const source = {
    family: 'evm',
    asset: {
      balance: {
        availableRaw: '30',
        mainRaw: '11',
        privateRaw: '19'
      }
    }
  }

  expect(resolveWalletSwapSourceAvailableRaw(source, 'main')).toBe('11')
  expect(resolveWalletSwapSourceAvailableRaw(source, 'private')).toBe('19')
  expect(
    resolveWalletSwapSourceAvailableRaw(
      { family: 'evm', asset: { balance: { availableRaw: '7' } } },
      'main'
    )
  ).toBe('7')
  expect(
    resolveWalletSwapSourceAvailableRaw(
      { family: 'evm', asset: { balance: { availableRaw: '7' } } },
      'private'
    )
  ).toBeUndefined()
})

test('keeps the canonical available balance for non-EVM swap sources', () => {
  const source = {
    family: 'near',
    asset: { balance: { availableRaw: '42' } }
  }

  expect(resolveWalletSwapSourceAvailableRaw(source, 'private')).toBe('42')
})

test('applies Private execution only to an EVM source that has a Private account', () => {
  expect(
    resolveSwapExecutionSourceMode({
      requestedMode: 'private',
      isPrivateFunding: false,
      sourceFamily: 'evm',
      privateSourceAvailable: true
    })
  ).toBe('private')
  expect(
    resolveSwapExecutionSourceMode({
      requestedMode: 'private',
      isPrivateFunding: false,
      sourceFamily: 'solana',
      privateSourceAvailable: false
    })
  ).toBe('main')
  expect(
    resolveSwapExecutionSourceMode({
      requestedMode: 'private',
      isPrivateFunding: true,
      sourceFamily: 'evm',
      privateSourceAvailable: true
    })
  ).toBe('main')
})

test('binds Private execution confidentiality into the live quote identity', () => {
  const publicRequest = buildLiveSwapQuoteRequest({
    tokenIn: quoteToken,
    tokenOut: { ...quoteToken, assetId: 'nep141:btc.omft.near', rheaChainId: 'btc' },
    amountIn: '1',
    slippage: 1,
    refundAddress: '0x1111111111111111111111111111111111111111',
    recipientAddress: 'bc1qrecipient',
    blocked: false
  })
  const privateRequest = buildLiveSwapQuoteRequest({
    tokenIn: quoteToken,
    tokenOut: { ...quoteToken, assetId: 'nep141:btc.omft.near', rheaChainId: 'btc' },
    amountIn: '1',
    slippage: 1,
    refundAddress: '0x2222222222222222222222222222222222222222',
    recipientAddress: 'bc1qrecipient',
    confidentiality: 'basic',
    blocked: false
  })

  expect(publicRequest).not.toHaveProperty('confidentiality')
  expect(privateRequest).toMatchObject({ confidentiality: 'basic' })
  expect(privateRequest?.key).not.toBe(publicRequest?.key)
})
