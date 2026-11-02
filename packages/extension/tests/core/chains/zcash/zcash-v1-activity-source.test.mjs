import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseAccountId } from '../../../../src/core/accounts/domain/index.ts'
import { buildActivityReadModel } from '../../../../src/core/activity/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { mapZcashV1TransactionToActivityItem } from '../../../../src/infrastructure/activity/index.ts'

const scope = {
  keyDomainId: parseKeyDomainId('key-domain:zcash-v1'),
  accountId: parseAccountId('account:zcash-v1')
}

function transaction(overrides = {}) {
  return {
    id: 'zcash-v1:send',
    txHash: 'ABCDEF',
    status: 'pending',
    type: 'send',
    amount: '1.25000001',
    to: 'u1recipient',
    from: 'u1sender',
    fromType: 'shielded',
    fee: '0.0001',
    timestamp: 1_000,
    network: 'mainnet',
    ...overrides
  }
}

test.describe('Zcash V1 Activity source', () => {
  test('preserves the V1 record while normalizing its display amount and status', () => {
    const item = mapZcashV1TransactionToActivityItem(transaction(), scope)

    expect(item).toMatchObject({
      id: 'zcash-v1:send',
      source: 'zcash-v1',
      kind: 'transfer',
      status: 'broadcast',
      completeness: 'complete',
      snapshot: {
        direction: 'outgoing',
        primaryAmount: {
          assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
          amountRaw: '125000001'
        },
        recipient: { address: 'u1recipient' }
      },
      segments: [{ evidence: { transactionHash: 'ABCDEF' } }]
    })
    expect(
      buildActivityReadModel({ scope, localGraphs: [], supplementalItems: [item] }).items
    ).toEqual([item])
    expect(item.snapshot.sender).toBeUndefined()
  })

  test('maps incoming, shielded, confirming, and terminal states without changing V1', () => {
    expect(
      mapZcashV1TransactionToActivityItem(
        transaction({ type: 'receive', status: 'success', amount: '0.1' }),
        scope
      )
    ).toMatchObject({
      kind: 'receive',
      status: 'final',
      snapshot: { direction: 'incoming', primaryAmount: { amountRaw: '10000000' } }
    })
    expect(
      mapZcashV1TransactionToActivityItem(
        transaction({ type: 'shield', status: 'confirming', amount: '2' }),
        scope
      )
    ).toMatchObject({
      kind: 'shield',
      status: 'confirming',
      snapshot: { direction: 'self', primaryAmount: { amountRaw: '200000000' } }
    })
    expect(
      mapZcashV1TransactionToActivityItem(
        transaction({ status: 'failed', txHash: '', amount: '0' }),
        scope
      )
    ).toMatchObject({ status: 'failed', failureCode: 'unknown' })
  })

  test('rejects non-canonical or over-precision V1 amounts', () => {
    for (const amount of ['01', '-1', '1.000000001', '1e-8']) {
      expect(() => mapZcashV1TransactionToActivityItem(transaction({ amount }), scope)).toThrow(
        /amount/
      )
    }
  })

  test('builds an origin-relay-destination timeline for completed Supply', () => {
    const item = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'supply',
        status: 'success',
        txHash: 'zcash-origin-hash',
        depositAddress: 'intents-deposit-address',
        chainHashes: [
          { hash: 'zcash-origin-hash', chain: 'Zcash' },
          { hash: 'near-destination-hash', chain: 'Near' }
        ]
      }),
      scope
    )

    expect(item).toMatchObject({
      kind: 'supply',
      status: 'final',
      completeness: 'complete',
      segments: [
        {
          role: 'origin',
          target: { kind: 'onchain', chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d' },
          status: 'final',
          evidence: { transactionHash: 'zcash-origin-hash' }
        },
        {
          role: 'relay',
          target: { kind: 'relay', provider: 'NEAR Intents' },
          status: 'final',
          evidence: { externalReference: 'intents-deposit-address' }
        },
        {
          role: 'destination',
          target: { kind: 'onchain', chainId: 'near:mainnet' },
          status: 'final',
          evidence: { transactionHash: 'near-destination-hash' }
        }
      ]
    })
  })

  test('keeps an outbound EVM destination on its actual chain for legacy records', () => {
    const item = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'success',
        txHash: 'zcash-origin-hash',
        destinationTxHash: 'monad-destination-hash',
        depositAddress: 'intents-deposit-address',
        chainHashes: [
          { hash: 'zcash-origin-hash', chain: 'Zcash' },
          { hash: 'monad-destination-hash', chain: 'Monad' }
        ]
      }),
      scope
    )

    expect(item).toMatchObject({
      kind: 'swap',
      status: 'final',
      segments: [
        { role: 'origin', target: { chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d' } },
        { role: 'relay', target: { kind: 'relay', provider: 'NEAR Intents' } },
        {
          role: 'destination',
          target: { kind: 'onchain', chainId: 'eip155:143' },
          evidence: { transactionHash: 'monad-destination-hash' }
        }
      ]
    })
  })

  test('shows a reported destination hash without requiring separate chain hash history', () => {
    const item = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'confirming',
        txHash: 'zcash-origin-hash',
        destinationTxHash: 'evm-destination-hash',
        quoteBinding: {
          destinationAsset: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
        }
      }),
      scope
    )

    expect(item.segments.find(segment => segment.role === 'destination')).toMatchObject({
      target: { kind: 'onchain', chainId: 'eip155:1' },
      evidence: { transactionHash: 'evm-destination-hash' }
    })
  })

  test('uses the quote binding as the complete cross-chain swap snapshot', () => {
    const item = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'success',
        txHash: 'zcash-origin-hash',
        chainHashes: [
          { hash: 'zcash-origin-hash', chain: 'Zcash' },
          { hash: 'avalanche-destination-hash', chain: 'Avalanche' }
        ],
        quoteBinding: {
          depositAddress: 'intents-deposit-address',
          destinationAsset: 'eip155:43114/slip44:9000',
          expectedAmountOut: '123456789'
        }
      }),
      scope
    )

    expect(item).toMatchObject({
      kind: 'swap',
      status: 'final',
      completeness: 'complete',
      snapshot: {
        counterAmount: {
          assetId: 'eip155:43114/slip44:9000',
          amountRaw: '123456789'
        }
      },
      segments: [
        { role: 'origin' },
        {
          role: 'relay',
          evidence: { externalReference: 'intents-deposit-address' }
        },
        {
          role: 'destination',
          target: { kind: 'onchain', chainId: 'eip155:43114' }
        }
      ]
    })
  })

  test('maps persisted Intents protocol assets without breaking the Activity list', () => {
    const gnosisUsdc = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'success',
        txHash: 'zcash-origin-hash',
        quoteBinding: {
          destinationAsset: 'nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near',
          expectedAmountOut: '2500000'
        }
      }),
      scope
    )
    const unknownProtocolAsset = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'success',
        txHash: 'zcash-origin-hash',
        quoteBinding: {
          destinationAsset: 'unsupported:protocol-asset',
          expectedAmountOut: '2500000'
        }
      }),
      scope
    )
    const unknownOmftAsset = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'success',
        txHash: 'zcash-origin-hash',
        quoteBinding: {
          destinationAsset: 'nep141:future-chain-token.omft.near',
          expectedAmountOut: '2500000'
        }
      }),
      scope
    )

    expect(gnosisUsdc.snapshot.counterAmount).toEqual({
      assetId: 'eip155:100/erc20:0x2a22f9c3b484c3629090feed35f17ff8f88f76f0',
      amountRaw: '2500000'
    })
    expect(unknownProtocolAsset.snapshot.counterAmount).toBeUndefined()
    expect(unknownOmftAsset.snapshot.counterAmount).toBeUndefined()
    expect(() =>
      buildActivityReadModel({
        scope,
        localGraphs: [],
        supplementalItems: [gnosisUsdc, unknownProtocolAsset, unknownOmftAsset]
      })
    ).not.toThrow()
  })

  test('keeps Withdraw processing until its destination Zcash confirmations finish', () => {
    const item = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'withdraw',
        status: 'relay_confirmed',
        txHash: 'near-origin-hash',
        destinationTxHash: 'zcash-destination-hash',
        depositAddress: 'withdraw-relay-reference',
        chainHashes: [{ hash: 'near-origin-hash', chain: 'Near' }],
        confirmations: 2,
        requiredConfirmations: 10
      }),
      scope
    )

    expect(item).toMatchObject({
      kind: 'withdraw',
      status: 'confirming',
      segments: [
        { role: 'origin', target: { chainId: 'near:mainnet' }, status: 'final' },
        { role: 'relay', status: 'final' },
        {
          role: 'destination',
          target: { chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d' },
          status: 'confirming',
          evidence: {
            transactionHash: 'zcash-destination-hash',
            confirmations: 2,
            requiredConfirmations: 10
          }
        }
      ]
    })
  })

  test('surfaces a refund as a relay failure without rewriting the origin evidence', () => {
    const item = mapZcashV1TransactionToActivityItem(
      transaction({
        type: 'swap',
        status: 'failed',
        txHash: 'zcash-origin-hash',
        depositAddress: 'refunded-relay',
        memo: 'Refunded'
      }),
      scope
    )

    expect(item).toMatchObject({
      status: 'failed',
      failureCode: 'refunded',
      segments: [
        { role: 'origin', status: 'broadcast', evidence: { transactionHash: 'zcash-origin-hash' } },
        { role: 'relay', status: 'failed', failureCode: 'refunded' }
      ]
    })
  })
})
