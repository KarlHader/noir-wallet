import { test } from 'node:test'
import { expect } from '@playwright/test'

import { discoverNearAccounts } from '../../../../src/infrastructure/chains/near/near-account-discovery.ts'

const publicKey = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25'
const implicitAccountId = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'

function response(accountIds, responsePublicKey = publicKey) {
  return new Response(
    JSON.stringify({
      account_ids: accountIds,
      public_key: responsePublicKey
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

test.describe('NEAR named Account discovery', () => {
  test('verifies FullAccess ownership and selects the funded named Account automatically', async () => {
    const requests = []
    const result = await discoverNearAccounts({
      network: 'testnet',
      publicKey,
      fetchImpl: async url => {
        requests.push(String(url))
        return response(['empty.testnet', 'funded.testnet', 'limited.testnet', implicitAccountId])
      },
      rpc: {
        getAccount: async accountId => ({
          accountId,
          amountRaw: accountId === 'funded.testnet' ? '20' : '1',
          lockedRaw: '0',
          storageUsage: 0,
          codeHash: '1'.repeat(32),
          blockHash: '1'.repeat(32),
          blockHeight: 1
        }),
        getAccessKey: async accountId => ({
          accountId,
          publicKey,
          nonce: '1',
          permission:
            accountId === 'limited.testnet'
              ? {
                  kind: 'function-call',
                  allowanceRaw: null,
                  receiverId: 'app.testnet',
                  methodNames: []
                }
              : { kind: 'full-access' },
          blockHash: '1'.repeat(32),
          blockHeight: 1
        })
      }
    })

    expect(requests).toEqual([
      `https://test.api.fastnear.com/v0/public_key/${encodeURIComponent(publicKey)}`
    ])
    expect(result).toEqual({
      implicitAccountId,
      primaryAccountId: 'funded.testnet',
      accountIds: ['funded.testnet', 'empty.testnet', implicitAccountId]
    })
  })

  test('keeps the implicit Account when no named FullAccess binding can be proven', async () => {
    const result = await discoverNearAccounts({
      network: 'mainnet',
      publicKey,
      fetchImpl: async () => response(['unverified.near', implicitAccountId]),
      rpc: {
        getAccount: async () => null,
        getAccessKey: async () => null
      }
    })
    expect(result).toEqual({
      implicitAccountId,
      primaryAccountId: implicitAccountId,
      accountIds: [implicitAccountId]
    })
  })

  test('rejects mismatched RPC snapshots and failed discovery responses', async () => {
    const result = await discoverNearAccounts({
      network: 'testnet',
      publicKey,
      fetchImpl: async () => response(['substituted.testnet']),
      rpc: {
        getAccount: async () => ({
          accountId: 'different.testnet',
          amountRaw: '20',
          lockedRaw: '0',
          storageUsage: 0,
          codeHash: '1'.repeat(32),
          blockHash: '1'.repeat(32),
          blockHeight: 1
        }),
        getAccessKey: async () => ({
          accountId: 'substituted.testnet',
          publicKey: `ed25519:${'1'.repeat(32)}`,
          nonce: '1',
          permission: { kind: 'full-access' },
          blockHash: '1'.repeat(32),
          blockHeight: 1
        })
      }
    })
    expect(result.primaryAccountId).toBe(implicitAccountId)

    await expect(
      discoverNearAccounts({
        network: 'testnet',
        publicKey,
        fetchImpl: async () => new Response('unavailable', { status: 503 }),
        rpc: { getAccount: async () => null, getAccessKey: async () => null }
      })
    ).rejects.toThrow('NEAR account discovery failed with HTTP 503')
  })

  test('rejects substituted keys, duplicate accounts, and unbounded candidate sets', async () => {
    const rpc = { getAccount: async () => null, getAccessKey: async () => null }
    await expect(
      discoverNearAccounts({
        network: 'mainnet',
        publicKey,
        fetchImpl: async () => response([], `ed25519:${'1'.repeat(32)}`),
        rpc
      })
    ).rejects.toThrow('Invalid NEAR account discovery response')
    await expect(
      discoverNearAccounts({
        network: 'mainnet',
        publicKey,
        fetchImpl: async () => response(['alice.near', 'alice.near']),
        rpc
      })
    ).rejects.toThrow('Duplicate NEAR account discovery result')
    await expect(
      discoverNearAccounts({
        network: 'mainnet',
        publicKey,
        fetchImpl: async () => response(Array.from({ length: 33 }, (_, index) => `a${index}.near`)),
        rpc
      })
    ).rejects.toThrow('Invalid NEAR account discovery response')
  })
})
