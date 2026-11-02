import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  ZCASH_NEW_WALLET_REORG_BUFFER,
  getFullZcashRecoveryBirthdayHeight,
  getSafeNewWalletBirthdayHeight,
  getSafeTransactionBirthdayHeight,
  selectCachedChainTipHeight
} from '../../../../src/core/wallet/birthday-height.ts'
import dayjs from '../../../../src/lib/dayjs.ts'
import {
  formatBirthdayDisplay,
  getBirthdayDateFromBlockTimestamp,
  getUtcDayStartTimestamp
} from '../../../../src/lib/zcash-birthday.ts'

test.describe('Zcash birthday height', () => {
  test('selects the newest safe cached chain height', () => {
    expect(selectCachedChainTipHeight([3_400_000, 3_399_000, 3_410_000])).toBe(3_410_000)
  })

  test('ignores unusable persisted heights', () => {
    expect(
      selectCachedChainTipHeight([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '3400000'])
    ).toBeNull()
  })

  test('keeps new-wallet birthdays below the chain tip reorg window', () => {
    expect(getSafeNewWalletBirthdayHeight(3_410_000)).toBe(
      3_410_000 - ZCASH_NEW_WALLET_REORG_BUFFER
    )
    expect(getSafeNewWalletBirthdayHeight(50)).toBe(1)
    expect(getSafeNewWalletBirthdayHeight('3410000')).toBe(0)
  })

  test('uses the network Sapling activation for a full recovery', () => {
    expect(getFullZcashRecoveryBirthdayHeight('mainnet')).toBe(419_200)
    expect(getFullZcashRecoveryBirthdayHeight('testnet')).toBe(280_000)
  })

  test('places a detected transaction birthday before the transaction without crossing activation', () => {
    expect(getSafeTransactionBirthdayHeight(500_000, 'mainnet')).toBe(
      500_000 - ZCASH_NEW_WALLET_REORG_BUFFER
    )
    expect(getSafeTransactionBirthdayHeight(419_250, 'mainnet')).toBe(419_200)
    expect(getSafeTransactionBirthdayHeight(undefined, 'mainnet')).toBeNull()
  })

  test('uses the UTC calendar day for the birthday and displayed height', () => {
    const timestamp = Date.UTC(2024, 1, 29, 23, 59, 59) / 1_000
    expect(getBirthdayDateFromBlockTimestamp(timestamp)?.format('YYYY-MM-DD')).toBe('2024-02-29')
    expect(getBirthdayDateFromBlockTimestamp(timestamp + 1)?.format('YYYY-MM-DD')).toBe(
      '2024-03-01'
    )
    expect(formatBirthdayDisplay(123_456, timestamp)).toBe('Feb 29, 2024 · #123,456')
  })

  test('converts the selected calendar day to UTC midnight independent of local timezone', () => {
    expect(getUtcDayStartTimestamp(dayjs('2024-02-29T23:45:00'))).toBe(
      Date.UTC(2024, 1, 29) / 1_000
    )
  })
})
