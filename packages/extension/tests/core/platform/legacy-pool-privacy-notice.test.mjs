import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mapWasmAccountBalanceToZcashBalance } from '../../../src/core/wallet/balance-summary.ts'
import {
  LEGACY_POOL_PRIVACY_NOTICE_STORAGE_KEY,
  hasLegacyOrchardBalance,
  shouldShowLegacyPoolPrivacyNotice
} from '../../../src/lib/legacy-pool-privacy-notice.ts'

test.describe('Legacy pool privacy notice', () => {
  test('preserves per-pool totals from the WASM balance summary', () => {
    const balance = mapWasmAccountBalanceToZcashBalance({
      sapling_balance: 1_000_000,
      orchard_balance: 2_000_000,
      ironwood_balance: 3_000_000,
      sapling_total_balance: 1_500_000,
      orchard_total_balance: 2_500_000,
      ironwood_total_balance: 3_500_000,
      unshielded_balance: 0
    })

    expect(balance.shieldedPools).toEqual({
      sapling: '0.015',
      orchard: '0.025',
      ironwood: '0.035'
    })
  })

  test('detects Orchard funds across all accounts without treating Sapling as migratable', () => {
    const saplingOnly = mapWasmAccountBalanceToZcashBalance({
      sapling_balance: 1,
      orchard_balance: 0,
      unshielded_balance: 0
    })
    const withOrchard = mapWasmAccountBalanceToZcashBalance({
      sapling_balance: 0,
      orchard_balance: 1,
      unshielded_balance: 0
    })

    expect(hasLegacyOrchardBalance([saplingOnly])).toBe(false)
    expect(hasLegacyOrchardBalance([saplingOnly, withOrchard])).toBe(true)
  })

  test('shows once from this release onward while an Orchard balance remains', () => {
    expect(LEGACY_POOL_PRIVACY_NOTICE_STORAGE_KEY).toBe('legacy_pool_privacy_notice_shown')
    expect(shouldShowLegacyPoolPrivacyNotice(true, false)).toBe(true)
    expect(shouldShowLegacyPoolPrivacyNotice(true, true)).toBe(false)
    expect(shouldShowLegacyPoolPrivacyNotice(false, false)).toBe(false)
  })
})
