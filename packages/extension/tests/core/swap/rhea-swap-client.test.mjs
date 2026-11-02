import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createRheaSwapClient,
  getRheaSwapErrorMessage,
  RheaSwapClientError
} from '../../../src/popup/services/rhea-swap-client.ts'
import { RHEA_SWAP_CHAIN_CATALOG } from '../../../src/core/services/rhea-swap/index.ts'

function token() {
  return {
    assetId: 'nep141:eth.omft.near',
    blockchain: 'eth',
    contractAddress: null,
    decimals: 18,
    icon: null,
    price: 1,
    priceUpdatedAt: '2026-09-02T00:00:00.000Z',
    symbol: 'ETH',
    rheaChainId: '1',
    tokenListChainId: 1,
    rheaAddress: 'nep141:eth.omft.near',
    isNative: true
  }
}

test('shows the useful minimum from RHEA quote and swap errors', () => {
  expect(
    getRheaSwapErrorMessage(
      new RheaSwapClientError('Temporary swap limits: minimum swap amount is $1,000')
    )
  ).toBe('Minimum swap amount is $1,000.')
  expect(getRheaSwapErrorMessage(new Error('Minimum swap amount is $1,000'))).toBe(
    'Amount is below the current minimum for this Swap route.'
  )
})

test('retains both directions for every supported chain without evicting source catalogs', async () => {
  let calls = 0
  const client = createRheaSwapClient(async message => {
    calls += 1
    const chain = RHEA_SWAP_CHAIN_CATALOG.find(
      chain => chain.tokenListChainId === message.tokenListChainIds[0]
    )
    return {
      result: {
        tokens: [
          {
            ...token(),
            rheaChainId: chain.apiChainId,
            tokenListChainId: chain.tokenListChainId,
            blockchain: chain.blockchain
          }
        ],
        failedChainIds: []
      }
    }
  })
  for (const direction of ['from', 'cross-chain-to']) {
    for (const chain of RHEA_SWAP_CHAIN_CATALOG) {
      await client.listTokens({ direction, tokenListChainIds: [chain.tokenListChainId] })
    }
  }
  const initialCalls = calls
  for (const direction of ['from', 'cross-chain-to']) {
    for (const chain of RHEA_SWAP_CHAIN_CATALOG) {
      await client.listTokens({ direction, tokenListChainIds: [chain.tokenListChainId] })
    }
  }
  expect(calls).toBe(initialCalls)
})
