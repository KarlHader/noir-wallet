import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { readNearBalances } from '../../../../src/infrastructure/chains/near/near-balance-reader.ts'

const blockHash = '11111111111111111111111111111111'

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getAccount: async accountId => ({
      accountId,
      amountRaw: '100',
      lockedRaw: '20',
      storageUsage: 30,
      codeHash: blockHash,
      blockHash,
      blockHeight: 40
    }),
    getFungibleTokenBalance: async (contractId, accountId) => ({
      contractId,
      accountId,
      amountRaw: contractId === 'a.testnet' ? '1' : '2',
      blockHash,
      blockHeight: 41
    }),
    ...overrides
  }
}

test.describe('NEAR balance reader', () => {
  test('attests the chain and reads native plus explicitly trusted NEP-141 assets', async () => {
    const calls = []
    const result = await readNearBalances({
      chainId: NEAR_NETWORKS.testnet.chainId,
      accountId: 'alice.testnet',
      trustedTokens: [
        { contractId: 'z_token.testnet', symbol: 'Z', decimals: 6 },
        { contractId: 'a.testnet', symbol: 'A', decimals: 18 }
      ],
      now: () => 12_345,
      rpc: rpc({
        assertExpectedChain: async () => calls.push('attest'),
        getAccount: async accountId => {
          calls.push(`account:${accountId}`)
          return rpc().getAccount(accountId)
        },
        getFungibleTokenBalance: async (contractId, accountId) => {
          calls.push(`token:${contractId}`)
          return rpc().getFungibleTokenBalance(contractId, accountId)
        }
      })
    })

    expect(calls).toEqual([
      'attest',
      'account:alice.testnet',
      'token:z_token.testnet',
      'token:a.testnet'
    ])
    expect(result).toEqual({
      chainId: 'near:testnet',
      accountId: 'alice.testnet',
      native: {
        assetId: 'near:testnet/slip44:397',
        amountRaw: '100',
        lockedRaw: '20',
        storageUsage: 30,
        blockHash,
        blockHeight: 40
      },
      tokens: [
        {
          assetId: 'near:testnet/nep141:a.testnet',
          contractId: 'a.testnet',
          symbol: 'A',
          decimals: 18,
          amountRaw: '1',
          blockHash,
          blockHeight: 41
        },
        {
          assetId: 'near:testnet/nep141:z%5Ftoken.testnet',
          contractId: 'z_token.testnet',
          symbol: 'Z',
          decimals: 6,
          amountRaw: '2',
          blockHash,
          blockHeight: 41
        }
      ],
      updatedAt: 12_345
    })
  })

  test('does not query tokens for a missing account or return partial token reads', async () => {
    let tokenRead = false
    await expect(
      readNearBalances({
        chainId: NEAR_NETWORKS.testnet.chainId,
        accountId: 'missing.testnet',
        trustedTokens: [{ contractId: 'wrap.testnet', symbol: 'wNEAR', decimals: 24 }],
        rpc: rpc({
          getAccount: async () => null,
          getFungibleTokenBalance: async () => {
            tokenRead = true
            throw new Error('unexpected')
          }
        })
      })
    ).rejects.toThrow(/account was not found/)
    expect(tokenRead).toBe(false)

    await expect(
      readNearBalances({
        chainId: NEAR_NETWORKS.testnet.chainId,
        accountId: 'alice.testnet',
        trustedTokens: [
          { contractId: 'a.testnet', symbol: 'A', decimals: 1 },
          { contractId: 'b.testnet', symbol: 'B', decimals: 2 }
        ],
        rpc: rpc({
          getFungibleTokenBalance: async contractId => {
            if (contractId === 'b.testnet') throw new Error('unavailable')
            return rpc().getFungibleTokenBalance(contractId, 'alice.testnet')
          }
        })
      })
    ).rejects.toThrow(/unavailable/)
  })

  test('rejects account and token responses that cross the requested identity', async () => {
    await expect(
      readNearBalances({
        chainId: NEAR_NETWORKS.testnet.chainId,
        accountId: 'alice.testnet',
        rpc: rpc({
          getAccount: async () => ({
            ...(await rpc().getAccount('mallory.testnet')),
            accountId: 'mallory.testnet'
          })
        })
      })
    ).rejects.toThrow(/account response identity mismatch/)

    await expect(
      readNearBalances({
        chainId: NEAR_NETWORKS.testnet.chainId,
        accountId: 'alice.testnet',
        trustedTokens: [{ contractId: 'wrap.testnet', symbol: 'wNEAR', decimals: 24 }],
        rpc: rpc({
          getFungibleTokenBalance: async () =>
            rpc().getFungibleTokenBalance('other.testnet', 'alice.testnet')
        })
      })
    ).rejects.toThrow(/token response identity mismatch/)
  })

  test('rejects duplicate/untrusted metadata and malformed chain or account before RPC access', async () => {
    let accessedRpc = false
    const trackedRpc = rpc({
      assertExpectedChain: async () => {
        accessedRpc = true
      }
    })
    await expect(
      readNearBalances({
        chainId: 'near:unsupported',
        accountId: 'alice.near',
        rpc: trackedRpc
      })
    ).rejects.toThrow(/Unsupported NEAR chain ID/)
    await expect(
      readNearBalances({
        chainId: NEAR_NETWORKS.mainnet.chainId,
        accountId: 'Alice.near',
        rpc: trackedRpc
      })
    ).rejects.toThrow(/Invalid NEAR account ID/)
    await expect(
      readNearBalances({
        chainId: NEAR_NETWORKS.testnet.chainId,
        accountId: 'alice.testnet',
        trustedTokens: [
          { contractId: 'wrap.testnet', symbol: 'wNEAR', decimals: 24 },
          { contractId: 'wrap.testnet', symbol: 'COPY', decimals: 1 }
        ],
        rpc: trackedRpc
      })
    ).rejects.toThrow(/Duplicate NEAR fungible token/)
    expect(accessedRpc).toBe(false)
  })
})
