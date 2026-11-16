import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import { createSolanaActivityHistorySource } from '../../../../src/infrastructure/chains/solana/solana-activity-history-source.ts'

const owner = '11111111111111111111111111111111'
const tokenAccount = '11111111111111111111111111111112'
const mint = '11111111111111111111111111111113'
const signature = '1'.repeat(64)
const scope = { keyDomainId: 'wallet-domain', accountId: 'account-1' }

test.describe('Solana activity history source', () => {
  test('finds token transfers through non-zero owned token accounts', async () => {
    const queriedAddresses = []
    const source = createSolanaActivityHistorySource({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      rpc: {
        getTokenAccountsByOwner: async (_owner, program) => ({
          contextSlot: 1,
          accounts:
            program === 'legacy'
              ? [
                  {
                    accountAddress: tokenAccount,
                    program: 'legacy',
                    mint,
                    owner,
                    state: 'initialized',
                    isNative: false,
                    amountRaw: '60876028',
                    decimals: 6
                  }
                ]
              : []
        }),
        getSignaturesForAddress: async address => {
          queriedAddresses.push(address)
          return address === tokenAccount
            ? [{ signature, slot: 42, blockTime: 1_700_000_000, status: 'finalized' }]
            : []
        },
        getTransactionSummary: async () => ({
          signature,
          slot: 42,
          blockTime: 1_700_000_000,
          failed: false,
          feeRaw: '5000',
          nativeDeltaRaw: '0',
          tokenDeltas: [{ mint, amountRaw: '2500000', decimals: 6 }]
        })
      }
    })

    await expect(source.readAddressActivity({ scope, address: owner })).resolves.toEqual([
      expect.objectContaining({
        id: `rpc:solana:${signature}`,
        kind: 'transfer',
        status: 'final',
        completeness: 'partial',
        snapshot: expect.objectContaining({
          direction: 'incoming',
          primaryAmount: {
            assetId: `${SOLANA_NETWORKS.mainnet.chainId}/token:${mint}`,
            amountRaw: '2500000'
          }
        })
      })
    ])
    expect(queriedAddresses).toEqual([owner, tokenAccount])
  })

  test('finds prior token transfers after the owned token account balance reaches zero', async () => {
    const queriedAddresses = []
    const source = createSolanaActivityHistorySource({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      rpc: {
        getTokenAccountsByOwner: async (_owner, program) => ({
          contextSlot: 1,
          accounts:
            program === 'legacy'
              ? [
                  {
                    accountAddress: tokenAccount,
                    program: 'legacy',
                    mint,
                    owner,
                    state: 'initialized',
                    isNative: false,
                    amountRaw: '0',
                    decimals: 6
                  }
                ]
              : []
        }),
        getSignaturesForAddress: async address => {
          queriedAddresses.push(address)
          return address === tokenAccount
            ? [{ signature, slot: 42, blockTime: 1_700_000_000, status: 'finalized' }]
            : []
        },
        getTransactionSummary: async () => ({
          signature,
          slot: 42,
          blockTime: 1_700_000_000,
          failed: false,
          feeRaw: '5000',
          nativeDeltaRaw: '0',
          tokenDeltas: [{ mint, amountRaw: '2500000', decimals: 6 }]
        })
      }
    })

    await expect(source.readAddressActivity({ scope, address: owner })).resolves.toEqual([
      expect.objectContaining({
        id: `rpc:solana:${signature}`,
        snapshot: expect.objectContaining({
          primaryAmount: {
            assetId: `${SOLANA_NETWORKS.mainnet.chainId}/token:${mint}`,
            amountRaw: '2500000'
          }
        })
      })
    ])
    expect(queriedAddresses).toEqual([owner, tokenAccount])
  })

  test('uses the persisted signature cursor and skips known finalized transaction details', async () => {
    const signatureRequests = []
    let summaryCalls = 0
    const source = createSolanaActivityHistorySource({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      rpc: {
        getTokenAccountsByOwner: async () => ({ contextSlot: 1, accounts: [] }),
        getSignaturesForAddress: async (address, limit, until) => {
          signatureRequests.push({ address, limit, until })
          return [{ signature, slot: 42, blockTime: 1_700_000_000, status: 'finalized' }]
        },
        getTransactionSummary: async () => {
          summaryCalls += 1
          return null
        }
      }
    })

    await expect(
      source.readAddressActivity({
        scope,
        address: owner,
        knownFinalizedSignatures: [signature],
        untilSignature: signature
      })
    ).resolves.toEqual([])
    expect(signatureRequests).toEqual([{ address: owner, limit: 8, until: signature }])
    expect(summaryCalls).toBe(0)
  })
})
