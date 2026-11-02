import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { createFastNearAccountTokenClient } from '../../../../src/infrastructure/chains/near/near-fastnear-client.ts'

test.describe('FastNear account token client', () => {
  test('reads the complete indexed FT inventory from the network-specific endpoint', async () => {
    const requests = []
    const client = createFastNearAccountTokenClient({
      chainId: NEAR_NETWORKS.mainnet.chainId,
      fetchImpl: async (url, init) => {
        requests.push({ url, init })
        return new Response(
          JSON.stringify({
            account_id: 'alice.near',
            tokens: [
              {
                contract_id: 'usdt.tether-token.near',
                balance: '2500000',
                last_update_block_height: 123
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    })

    await expect(client.getFungibleTokenBalances('alice.near')).resolves.toEqual([
      {
        contractId: 'usdt.tether-token.near',
        amountRaw: '2500000',
        lastUpdateBlockHeight: 123
      }
    ])
    expect(requests).toEqual([
      {
        url: 'https://api.fastnear.com/v1/account/alice.near/ft',
        init: {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          timeoutMs: 8000
        }
      }
    ])
  })

  test('preserves unusable legacy rows for targeted RPC fallback', async () => {
    const client = createFastNearAccountTokenClient({
      chainId: NEAR_NETWORKS.mainnet.chainId,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            account_id: 'alice.near',
            tokens: [
              {
                contract_id: 'legacy-token.near',
                balance: '',
                last_update_block_height: null
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    })

    await expect(client.getFungibleTokenBalances('alice.near')).resolves.toEqual([
      {
        contractId: 'legacy-token.near',
        amountRaw: null,
        lastUpdateBlockHeight: null
      }
    ])
  })

  test('rejects mismatched accounts, duplicate contracts, and malformed balances atomically', async () => {
    for (const payload of [
      { account_id: 'bob.near', tokens: [] },
      {
        account_id: 'alice.near',
        tokens: [
          { contract_id: 'token.near', balance: '1', last_update_block_height: 1 },
          { contract_id: 'token.near', balance: '2', last_update_block_height: 2 }
        ]
      },
      {
        account_id: 'alice.near',
        tokens: [{ contract_id: 'token.near', balance: '-1', last_update_block_height: 1 }]
      }
    ]) {
      const client = createFastNearAccountTokenClient({
        chainId: NEAR_NETWORKS.mainnet.chainId,
        fetchImpl: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      })
      await expect(client.getFungibleTokenBalances('alice.near')).rejects.toThrow(
        /Invalid FastNear fungible token response/
      )
    }
  })
})
