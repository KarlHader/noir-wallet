import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import { readSolanaBalances } from '../../../../src/infrastructure/chains/solana/solana-balance-reader.ts'

const address = '11111111111111111111111111111111'
const secondAddress = '11111111111111111111111111111112'
const mint = '11111111111111111111111111111113'

function account(accountAddress, amountRaw, program = 'legacy', decimals = 6) {
  return Object.freeze({
    accountAddress,
    program,
    mint,
    owner: address,
    state: 'initialized',
    isNative: false,
    amountRaw,
    decimals
  })
}

test.describe('Solana balance reader', () => {
  test('attests the chain and aggregates raw SPL token account amounts by mint', async () => {
    const calls = []
    const result = await readSolanaBalances({
      chainId: SOLANA_NETWORKS.devnet.chainId,
      address,
      now: () => 12_345,
      rpc: {
        assertExpectedChain: async () => calls.push('attest'),
        getBalanceSnapshot: async () => ({ contextSlot: 10, amountRaw: '99' }),
        getTokenAccountsByMints: async (_owner, mints) => {
          calls.push(mints)
          return {
            contextSlot: 11,
            accounts: [account(secondAddress, '2'), account(address, '3')]
          }
        }
      },
      tokenMints: [mint]
    })

    expect(calls).toEqual(['attest', [mint]])
    expect(result).toEqual({
      chainId: SOLANA_NETWORKS.devnet.chainId,
      address,
      native: {
        assetId: `${SOLANA_NETWORKS.devnet.chainId}/slip44:501`,
        amountRaw: '99',
        contextSlot: 10
      },
      tokens: [
        {
          assetId: `${SOLANA_NETWORKS.devnet.chainId}/token:${mint}`,
          mint,
          program: 'legacy',
          amountRaw: '5',
          decimals: 6,
          accountAddresses: [address, secondAddress],
          contextSlot: 11
        }
      ],
      updatedAt: 12_345
    })
  })

  test('fails closed when one mint is returned by incompatible programs or decimals', async () => {
    const run = token2022Account =>
      readSolanaBalances({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        address,
        rpc: {
          assertExpectedChain: async () => {},
          getBalanceSnapshot: async () => ({ contextSlot: 1, amountRaw: '0' }),
          getTokenAccountsByMints: async () => ({
            contextSlot: 1,
            accounts: [account(address, '1'), token2022Account]
          })
        },
        tokenMints: [mint]
      })

    await expect(run(account(secondAddress, '1', 'token2022'))).rejects.toThrow(
      /inconsistent identity/
    )
    await expect(run(account(secondAddress, '1', 'legacy', 9))).rejects.toThrow(
      /inconsistent identity/
    )
  })

  test('does not return partial balances when chain attestation or a token query fails', async () => {
    let balanceRead = false
    await expect(
      readSolanaBalances({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        address,
        rpc: {
          assertExpectedChain: async () => {
            throw new Error('wrong chain')
          },
          getBalanceSnapshot: async () => {
            balanceRead = true
            return { contextSlot: 1, amountRaw: '0' }
          },
          getTokenAccountsByMints: async () => ({ contextSlot: 1, accounts: [] })
        }
      })
    ).rejects.toThrow(/wrong chain/)
    expect(balanceRead).toBe(false)

    await expect(
      readSolanaBalances({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        address,
        rpc: {
          assertExpectedChain: async () => {},
          getBalanceSnapshot: async () => ({ contextSlot: 1, amountRaw: '9' }),
          getTokenAccountsByMints: async () => {
            throw new Error('unavailable')
          }
        },
        tokenMints: [mint]
      })
    ).rejects.toThrow(/unavailable/)
  })

  test('rejects unsupported chain IDs and malformed public keys before RPC access', async () => {
    let accessedRpc = false
    const rpc = {
      assertExpectedChain: async () => {
        accessedRpc = true
      },
      getBalanceSnapshot: async () => ({ contextSlot: 1, amountRaw: '0' }),
      getTokenAccountsByMints: async () => ({ contextSlot: 1, accounts: [] })
    }

    await expect(
      readSolanaBalances({ chainId: 'solana:unsupported', address, rpc })
    ).rejects.toThrow(/Unsupported Solana chain ID/)
    await expect(
      readSolanaBalances({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        address: 'not-a-public-key',
        rpc
      })
    ).rejects.toThrow(/Invalid Solana public key/)
    expect(accessedRpc).toBe(false)
  })
})
