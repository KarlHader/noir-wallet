import { test } from 'node:test'
import { expect } from '@playwright/test'

import { findExactBlockHeightByTime } from '../../../../src/core/zcash/block-time.ts'

function lookup({ targetTimestamp, approximateHeight, latestHeight, timeAt }) {
  return findExactBlockHeightByTime({
    targetTimestamp,
    approximateHeight,
    latestHeight,
    getBlockTime: async height => timeAt(height)
  })
}

test.describe('Exact Zcash birthday block lookup', () => {
  test('returns the first block at the requested timestamp', async () => {
    await expect(
      lookup({
        targetTimestamp: 500,
        approximateHeight: 10,
        latestHeight: 20,
        timeAt: height => height * 100
      })
    ).resolves.toBe(5)
  })

  test('searches backward and forward from an approximate result', async () => {
    const timeAt = height => height

    await expect(
      lookup({ targetTimestamp: 350, approximateHeight: 10_000, latestHeight: 20_000, timeAt })
    ).resolves.toBe(350)
    await expect(
      lookup({ targetTimestamp: 15_500, approximateHeight: 1, latestHeight: 20_000, timeAt })
    ).resolves.toBe(15_500)
  })

  test('clamps requests beyond chain bounds and searches back from the tip', async () => {
    const timeAt = height => height * 10

    await expect(
      lookup({ targetTimestamp: 1, approximateHeight: 500, latestHeight: 100, timeAt })
    ).resolves.toBe(1)
    await expect(
      lookup({ targetTimestamp: 10_000, approximateHeight: 10, latestHeight: 100, timeAt })
    ).resolves.toBe(100)
    await expect(
      lookup({ targetTimestamp: 0, approximateHeight: 10, latestHeight: 100, timeAt })
    ).resolves.toBe(1)
  })

  test('returns zero for invalid heights', async () => {
    await expect(
      lookup({ targetTimestamp: 1, approximateHeight: 0, latestHeight: 100, timeAt: () => 1 })
    ).resolves.toBe(0)
  })
})
