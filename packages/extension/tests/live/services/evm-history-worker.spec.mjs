import { expect, test } from '@playwright/test'

import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
import { resolveHistoryApiOrigin } from '../../../scripts/lib/extension-build-config.ts'
import { CHAIN_ID_TO_ANKR } from '../../../../evm-history-worker/src/index.ts'

const PROBE_ADDRESS = '0x000000000000000000000000000000000000dEaD'
const HISTORY_METHODS = [
  ['ankr_getTransactionsByAddress', 'transactions'],
  ['ankr_getTokenTransfers', 'transfers']
]

function historyOrigin() {
  return resolveHistoryApiOrigin(process.env.EVM_HISTORY_API_ORIGIN, 'production')
}

function supportedNetworks(networkMode) {
  return getEvmNetworkConfigs(networkMode).flatMap(network => {
    const blockchain = CHAIN_ID_TO_ANKR[network.chainId.slice('eip155:'.length)]
    return blockchain ? [{ ...network, blockchain }] : []
  })
}

async function probeHistory(origin, method, resultKey, networks) {
  const blockchains = networks.map(network => network.blockchain)
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        blockchain: blockchains,
        address: method === 'ankr_getTokenTransfers' ? [PROBE_ADDRESS] : PROBE_ADDRESS,
        pageSize: 1,
        descOrder: true
      }
    }),
    signal: AbortSignal.timeout(20_000)
  })
  expect(response.status, `${method} ${blockchains.join(',')} history probe`).toBe(200)
  const envelope = await response.json()
  expect(envelope).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
    result: { [resultKey]: expect.any(Array) }
  })
  expect(envelope.result[resultKey].length).toBeLessThanOrEqual(1)
  for (const item of envelope.result[resultKey]) {
    expect(blockchains).toContain(item.blockchain)
  }
}

test.describe('live EVM history Worker', () => {
  test.skip(
    process.env.LIVE_EVM_HISTORY_PROXY !== '1',
    'Set LIVE_EVM_HISTORY_PROXY=1 after the production Worker is deployed'
  )
  test.setTimeout(180_000)

  test('probes native and token history on every supported released chain', async () => {
    const origin = historyOrigin()
    const health = await fetch(`${origin}/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true })

    const networks = ['mainnet', 'testnet'].flatMap(supportedNetworks)
    expect(networks).toHaveLength(14)
    const probes = networks.flatMap(network =>
      HISTORY_METHODS.map(([method, resultKey]) => ({ network, method, resultKey }))
    )
    for (let offset = 0; offset < probes.length; offset += 3) {
      await Promise.all(
        probes
          .slice(offset, offset + 3)
          .map(({ network, method, resultKey }) =>
            probeHistory(origin, method, resultKey, [network])
          )
      )
    }
  })

  for (const networkMode of ['mainnet', 'testnet']) {
    test(`probes multi-chain native and token history on ${networkMode}`, async () => {
      const networks = supportedNetworks(networkMode).slice(0, 2)
      expect(networks).toHaveLength(2)
      for (const [method, resultKey] of HISTORY_METHODS) {
        await probeHistory(historyOrigin(), method, resultKey, networks)
      }
    })
  }
})
