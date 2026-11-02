import { expect, test } from '@playwright/test'
import { NEAR_NETWORKS } from '../../../src/config/networks.ts'
import { createNearActivityHistorySource } from '../../../src/infrastructure/chains/near/near-activity-history-source.ts'
const scope = { keyDomainId: 'wallet-domain', accountId: 'account-1' }

test('reads live indexed Mainnet history when explicitly enabled', async () => {
  test.skip(process.env.LIVE_NEAR_ACTIVITY !== '1', 'Set LIVE_NEAR_ACTIVITY=1 to enable')
  const source = createNearActivityHistorySource({ chainId: NEAR_NETWORKS.mainnet.chainId })
  const items = await source.readAddressActivity({ scope, address: 'root.near' })
  expect(items.length).toBeGreaterThan(0)
  expect(items[0]).toMatchObject({ source: 'rpc', status: 'final' })
})
