import { expect, test } from '@playwright/test'

import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
import {
  createConfiguredEvmActivityHistorySource,
  createConfiguredEvmRpcClient
} from '../../../src/infrastructure/chains/evm/index.ts'

const READ_ONLY_PROBE_ADDRESS = '0x1111111111111111111111111111111111111112'
const PROBE_SCOPE = Object.freeze({
  keyDomainId: 'keydomain_live-evm-history',
  accountId: 'account_live-evm-history'
})

test.describe('live trusted EVM RPC profiles', () => {
  test.skip(process.env.LIVE_EVM_INTEGRATION !== '1', 'Set LIVE_EVM_INTEGRATION=1 to enable')
  test.setTimeout(120_000)

  for (const network of ['mainnet', 'testnet']) {
    test(`probes every ${network} chain, trusted USDC contract, and default finality`, async () => {
      const configuredNetworks = getEvmNetworkConfigs(network)
      for (const [index, configuredNetwork] of configuredNetworks.entries()) {
        const client = createConfiguredEvmRpcClient(network, configuredNetwork)
        await client.assertExpectedChain()
        expect(
          BigInt(await client.getNativeBalance(READ_ONLY_PROBE_ADDRESS))
        ).toBeGreaterThanOrEqual(0n)
        if (configuredNetwork.usdcContract) {
          expect(
            BigInt(
              await client.getErc20Balance(configuredNetwork.usdcContract, READ_ONLY_PROBE_ADDRESS)
            )
          ).toBeGreaterThanOrEqual(0n)
        }
        const history = createConfiguredEvmActivityHistorySource(network, configuredNetwork)
        if (configuredNetwork.historyApiUrl) {
          expect(history).toBeDefined()
          const activity = await history.readAddressActivity({
            scope: PROBE_SCOPE,
            address: READ_ONLY_PROBE_ADDRESS
          })
          expect(Array.isArray(activity)).toBe(true)
          expect(
            activity.every(item =>
              item.segments.every(segment => segment.target.chainId === configuredNetwork.chainId)
            )
          ).toBe(true)
        } else {
          expect(history).toBeUndefined()
        }
        if (index === 0) {
          const [latest, finalized] = await Promise.all([
            client.getLatestBlockFee(),
            client.getFinalizedBlockNumber()
          ])
          expect(BigInt(latest.blockNumber)).toBeGreaterThan(0n)
          expect(BigInt(latest.baseFeePerGas)).toBeGreaterThanOrEqual(0n)
          expect(BigInt(finalized)).toBeGreaterThan(0n)
          expect(BigInt(finalized)).toBeLessThanOrEqual(BigInt(latest.blockNumber))
        }
      }
    })
  }
})
