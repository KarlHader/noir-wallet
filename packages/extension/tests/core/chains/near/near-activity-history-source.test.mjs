import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { createNearActivityHistorySource } from '../../../../src/infrastructure/chains/near/near-activity-history-source.ts'

const scope = { keyDomainId: 'wallet-domain', accountId: 'account-1' }

test.describe('NEAR activity history source', () => {
  test('merges indexed incoming and outgoing native and token transfers', async () => {
    const requests = []
    const source = createNearActivityHistorySource({
      chainId: NEAR_NETWORKS.mainnet.chainId,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body)
        requests.push({ url, body })
        const incoming = body.direction === 'receiver'
        return new Response(
          JSON.stringify({
            resume_token: null,
            transfers: [
              {
                amount: incoming ? '2500000' : '-1000000000000000000000000',
                asset_id: incoming ? 'nep141:usdt.tether-token.near' : 'native:near',
                block_height: incoming ? '101' : '100',
                block_timestamp: incoming ? '1700000001000000000' : '1700000000000000000',
                other_account_id: incoming ? 'sender.near' : 'recipient.near',
                receipt_id: incoming ? 'receipt-in' : 'receipt-out',
                transaction_id: incoming ? 'transaction-in' : 'transaction-out',
                transfer_index: incoming ? 2 : 1
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    })

    const items = await source.readAddressActivity({ scope, address: 'alice.near' })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'rpc:near:transaction-in:2',
      status: 'final',
      completeness: 'complete',
      snapshot: {
        direction: 'incoming',
        primaryAmount: {
          assetId: `${NEAR_NETWORKS.mainnet.chainId}/nep141:usdt.tether-token.near`,
          amountRaw: '2500000'
        }
      }
    })
    expect(items[1]).toMatchObject({
      id: 'rpc:near:transaction-out:1',
      snapshot: {
        direction: 'outgoing',
        primaryAmount: {
          assetId: `${NEAR_NETWORKS.mainnet.chainId}/slip44:397`,
          amountRaw: '1000000000000000000000000'
        }
      }
    })
    expect(requests.map(request => request.body.direction)).toEqual(['receiver', 'sender'])
  })

  test('rejects malformed transfer rows atomically', async () => {
    const source = createNearActivityHistorySource({
      chainId: NEAR_NETWORKS.mainnet.chainId,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            resume_token: null,
            transfers: [
              {
                amount: '1',
                asset_id: 'native:near',
                block_height: '1',
                block_timestamp: '1',
                other_account_id: 'INVALID',
                receipt_id: 'receipt',
                transaction_id: null,
                transfer_index: 0
              }
            ]
          }),
          { status: 200 }
        )
    })

    await expect(source.readAddressActivity({ scope, address: 'alice.near' })).rejects.toThrow(
      /FastNear/
    )
  })
})
