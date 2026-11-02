import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildAddToPrivateEvmPath,
  buildMoveToMainEvmPath,
  buildPrivateEvmTransferPath,
  buildPrivateGasFundingPath,
  getEvmTokenFeeBalanceError,
  resolveEvmNativeMaximumAmount
} from '../../../../src/popup/pages/transactions/evm-send-validation.ts'
import { resolveAccountAvailableRaw } from '../../../../src/popup/services/transfer-availability.ts'
import {
  calculatePrivateFundingSourceAmount,
  calculateSuggestedPrivateGasFundingRaw
} from '../../../../src/core/transactions/private-funding.ts'

test.describe('EVM send validation', () => {
  test('preserves Max intent through both balance transfer directions and private Send', () => {
    const recipient = '0x2222222222222222222222222222222222222222'
    for (const path of [
      buildAddToPrivateEvmPath({
        assetId: 'eip155:1/slip44:60',
        chainId: 'eip155:1',
        amount: '0.9',
        maximum: true
      }),
      buildMoveToMainEvmPath({
        assetId: 'eip155:1/slip44:60',
        mainAddress: recipient,
        amount: '0.9',
        maximum: true
      }),
      buildPrivateEvmTransferPath({
        assetId: 'eip155:1/slip44:60',
        recipient,
        amount: '0.9',
        maximum: true
      })
    ]) {
      expect(new URL(path, 'https://wallet.invalid').searchParams.get('maximum')).toBe('1')
    }
  })
  test('never spends the aggregated total when Main or Private is selected', () => {
    const balance = { availableRaw: '30', mainRaw: '11', privateRaw: '19' }
    expect(resolveAccountAvailableRaw(balance, 'main')).toBe('11')
    expect(resolveAccountAvailableRaw(balance, 'private')).toBe('19')
    expect(resolveAccountAvailableRaw({ availableRaw: '7' }, 'main')).toBe('7')
    expect(resolveAccountAvailableRaw({ availableRaw: '7' }, 'private')).toBe('0')
  })

  test('explains the missing native gas balance before preparing a token transfer', () => {
    expect(getEvmTokenFeeBalanceError('token', '0', 'ETH')).toBe('Insufficient ETH balance.')
    expect(getEvmTokenFeeBalanceError('token', undefined, 'ETH')).toBe('Insufficient ETH balance.')
  })

  test('allows preparation when a native gas balance exists', () => {
    expect(getEvmTokenFeeBalanceError('token', '1', 'ETH')).toBeNull()
    expect(getEvmTokenFeeBalanceError('native', '0', 'ETH')).toBeNull()
  })

  test('reserves the live maximum fee when sending the native gas asset', () => {
    expect(resolveEvmNativeMaximumAmount('28213333648391137919', '21000000000000')).toBe(
      '28213312648391137919'
    )
    expect(() => resolveEvmNativeMaximumAmount('21000000000000', '21000000000000')).toThrow(
      'does not cover'
    )
    expect(() => resolveEvmNativeMaximumAmount('1.5', '1')).toThrow('Invalid')
  })

  test('routes Private sends through the constrained Confidential transfer flow', () => {
    const path = buildPrivateEvmTransferPath({
      assetId: 'eip155:1/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amount: '1.25'
    })
    const url = new URL(path, 'https://wallet.invalid')
    expect(url.pathname).toBe('/swap')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      privateTransfer: '1',
      source: 'eip155:1/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amount: '1.25',
      review: '1'
    })
  })

  test('locks one-click Add to Private to the selected asset and chain', () => {
    const path = buildAddToPrivateEvmPath({
      assetId: 'eip155:8453/erc20:0x3333333333333333333333333333333333333333',
      chainId: 'eip155:8453',
      amount: '1.25'
    })
    const url = new URL(path, 'https://wallet.invalid')
    expect(url.pathname).toBe('/swap')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      privateDestination: '1',
      balanceTransfer: '1',
      destinationChain: '8453',
      destinationAsset: 'eip155:8453/erc20:0x3333333333333333333333333333333333333333',
      source: 'eip155:8453/erc20:0x3333333333333333333333333333333333333333',
      review: '1',
      amount: '1.25'
    })
  })

  test('locks one-click Move to Main to Private mode and this account Main address', () => {
    const mainAddress = '0x4444444444444444444444444444444444444444'
    const path = buildMoveToMainEvmPath({
      assetId: 'eip155:1/slip44:60',
      mainAddress,
      amount: '0.5'
    })
    const url = new URL(path, 'https://wallet.invalid')
    expect(url.pathname).toBe('/swap')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      privateTransfer: '1',
      balanceTransfer: '1',
      source: 'eip155:1/slip44:60',
      recipient: mainAddress,
      review: '1',
      amount: '0.5'
    })
  })

  test('rejects malformed one-click transfer amounts', () => {
    expect(() =>
      buildAddToPrivateEvmPath({
        assetId: 'eip155:1/slip44:60',
        chainId: 'eip155:1',
        amount: '1e3'
      })
    ).toThrow('Invalid EVM transfer amount route')
  })

  test('locks dApp gas funding to the same-chain native asset and simplified review', () => {
    const input = {
      chainId: 'eip155:1',
      nativeAssetId: 'eip155:1/slip44:60',
      requestId: 'request-1',
      minimumOutputRaw: '100',
      suggestedOutputRaw: '500'
    }
    const url = new URL(buildPrivateGasFundingPath(input), 'https://wallet.invalid')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      source: input.nativeAssetId,
      destinationAsset: input.nativeAssetId,
      destinationChain: '1',
      privateFundingRequestId: 'request-1',
      balanceTransfer: '1',
      review: '1',
      minimumOutputRaw: '100',
      suggestedOutputRaw: '500'
    })
    expect(() =>
      buildPrivateGasFundingPath({ ...input, nativeAssetId: 'eip155:8453/slip44:60' })
    ).toThrow('Invalid')
    expect(() =>
      buildPrivateGasFundingPath({ ...input, nativeAssetId: 'eip155:1/erc20:0x1234' })
    ).toThrow('Invalid')
    expect(() => buildPrivateGasFundingPath({ ...input, suggestedOutputRaw: '99' })).toThrow(
      'Invalid'
    )
    expect(() => buildPrivateGasFundingPath({ ...input, minimumOutputRaw: '1e3' })).toThrow(
      'Invalid'
    )
  })

  test('does not turn an unestimated zero gas cost into a one-wei funding suggestion', () => {
    expect(calculateSuggestedPrivateGasFundingRaw('1', '0')).toBeNull()
    expect(
      calculateSuggestedPrivateGasFundingRaw('1', '0', {
        decimals: 18,
        nativePriceUsd: null
      })
    ).toBeNull()
  })

  test('uses the larger of the five-dollar reserve and the live gas budget', () => {
    const ethPrice = { decimals: 18, nativePriceUsd: '2000' }
    expect(calculateSuggestedPrivateGasFundingRaw('1', '0', ethPrice)).toBe('2500000000000000')
    expect(
      calculateSuggestedPrivateGasFundingRaw('1000000000000000', '1000000000000000', ethPrice)
    ).toBe('5000000000000000')
    expect(
      calculateSuggestedPrivateGasFundingRaw('1', '10', {
        decimals: 18,
        nativePriceUsd: null
      })
    ).toBe('41')
    expect(
      calculateSuggestedPrivateGasFundingRaw('1', '0', {
        decimals: 2,
        nativePriceUsd: '3'
      })
    ).toBe('167')
  })

  test('keeps every wei for the same canonical native asset despite route aliases', () => {
    const native = { assetId: 'eip155:8453/slip44:60', decimals: 18, price: 0 }
    expect(
      calculatePrivateFundingSourceAmount({
        suggestedOutputRaw: '1',
        source: native,
        destination: { ...native }
      })
    ).toBe('0.000000000000000001')
    expect(
      calculatePrivateFundingSourceAmount({
        suggestedOutputRaw: '1',
        source: native,
        destination: { ...native, decimals: 6 }
      })
    ).toBeNull()
  })

  test('rounds different assets up at the source token precision', () => {
    expect(
      calculatePrivateFundingSourceAmount({
        suggestedOutputRaw: '1',
        source: { assetId: 'eip155:1/erc20:source', decimals: 18, price: '1000' },
        destination: { assetId: 'eip155:1/erc20:destination', decimals: 18, price: '2000' }
      })
    ).toBe('0.000000000000000002')
  })

  test('rejects invalid funding amounts, decimals, prices and excessive output', () => {
    const priced = { decimals: 18, nativePriceUsd: '2000' }
    for (const raw of ['01', '-1', '1.5', `${'9'.repeat(79)}`]) {
      expect(calculateSuggestedPrivateGasFundingRaw(raw, '1', priced)).toBeNull()
    }
    expect(
      calculateSuggestedPrivateGasFundingRaw('1', '1', { ...priced, decimals: 256 })
    ).toBeNull()
    expect(
      calculateSuggestedPrivateGasFundingRaw('1', '1', { ...priced, nativePriceUsd: 'NaN' })
    ).toBeNull()
    expect(
      calculateSuggestedPrivateGasFundingRaw('1', '1', { ...priced, nativePriceUsd: '0' })
    ).toBeNull()
    expect(
      calculateSuggestedPrivateGasFundingRaw(((1n << 256n) - 1n).toString(), '1', priced)
    ).toBeNull()
    expect(
      calculatePrivateFundingSourceAmount({
        suggestedOutputRaw: '1',
        source: { assetId: 'eip155:1/slip44:60', decimals: 18, price: Number.NaN },
        destination: { assetId: 'eip155:8453/slip44:60', decimals: 18, price: 2000 }
      })
    ).toBeNull()
    expect(
      calculatePrivateFundingSourceAmount({
        suggestedOutputRaw: '1',
        source: { assetId: ' ', decimals: 18, price: 2000 },
        destination: { assetId: 'eip155:8453/slip44:60', decimals: 18, price: 2000 }
      })
    ).toBeNull()
  })
})
