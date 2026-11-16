import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  resolveAccountAvailableRaw,
  resolveEvmAccountAvailability,
  resolvePortfolioTransferAvailability,
  resolveZcashTransferAvailability
} from '../../../src/popup/services/transfer-availability.ts'

test('keeps account balances separate and labels native spendability only after Max', () => {
  const balance = {
    availableRaw: '1000000',
    mainRaw: '900000',
    privateRaw: '100000',
    privateOnchainRaw: '80000'
  }
  expect(resolveAccountAvailableRaw(balance, 'main')).toBe('900000')
  expect(resolveAccountAvailableRaw(balance, 'private')).toBe('80000')
  expect(resolveEvmAccountAvailability(balance, 6, '0xprivate')).toMatchObject({
    mainDisplay: '0.9',
    privateDisplay: '0.08',
    privateSourceAvailable: true
  })

  const beforeMax = resolvePortfolioTransferAvailability({
    balanceRaw: '900000',
    decimals: 6,
    isNative: true,
    maximumRaw: null
  })
  expect(beforeMax).toEqual({ amountRaw: '900000', display: '0.9', label: 'Balance' })
  const afterMax = resolvePortfolioTransferAvailability({
    balanceRaw: '900000',
    decimals: 6,
    isNative: true,
    maximumRaw: '870000'
  })
  expect(afterMax).toEqual({ amountRaw: '870000', display: '0.87', label: 'Available' })
  expect(
    resolvePortfolioTransferAvailability({
      balanceRaw: '900000',
      decimals: 6,
      isNative: false,
      maximumRaw: null
    }).label
  ).toBe('Available')
})

test('shares the Zcash fee-tier reserve between Send, Swap, Unshield, and Speed Up', () => {
  const fast = resolveZcashTransferAvailability({
    availableBalance: '1.00000000',
    selectedFeeZats: 60000,
    standardFeeZats: 15000
  })
  expect(fast).toEqual({ amount: '0.99955', fallbackAmount: '0.99955' })
  expect(
    resolveZcashTransferAvailability({
      availableBalance: '0.0001',
      selectedFeeZats: 60000,
      standardFeeZats: 15000
    }).amount
  ).toBe('0')
  expect(
    resolveZcashTransferAvailability({
      availableBalance: '1',
      selectedFeeZats: 60000,
      standardFeeZats: 15000,
      maximumAmount: '0.99933'
    }).amount
  ).toBe('0.99933')
})
