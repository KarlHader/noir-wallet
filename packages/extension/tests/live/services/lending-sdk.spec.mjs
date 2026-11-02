import { expect, test } from '@playwright/test'
import { batchViewsData } from '@rhea-finance/cross-chain-sdk'

const ZEC_NEAR_TOKEN_ID = 'zec.omft.near'

test('RHEA SDK reads live prices from its configured Pyth oracle', async () => {
  test.skip(process.env.LIVE_LENDING_SDK !== '1', 'Set LIVE_LENDING_SDK=1 to query RHEA')

  const result = await batchViewsData()
  const zecPrice = Number(result.assetsView?.[ZEC_NEAR_TOKEN_ID]?.price?.usd)

  expect(result.config.enable_pyth_oracle).toBe(true)
  expect(result.config.pyth_oracle_account_id).toBe('aggregate-oracle.near')
  expect(Object.keys(result.assetsView || {}).length).toBeGreaterThan(0)
  expect(zecPrice).toBeGreaterThan(0)
})
