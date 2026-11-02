import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import {
  prepareSolanaNativeTransfer,
  prepareSolanaTokenTransfer,
  assertSolanaTransferSigningMatchesPrepared,
  parsePreparedSolanaNativeTransfer,
  parsePreparedSolanaTokenTransfer,
  SolanaTransferError
} from '../../../../src/infrastructure/chains/solana/solana-transfer-preparer.ts'

const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const blockhash = 'SysvarC1ock11111111111111111111111111111111'

function harness(balance = '10000') {
  const calls = []
  const rpc = {
    assertExpectedChain: async () => calls.push('attest'),
    getBalanceSnapshot: async address => {
      calls.push(['balance', address])
      return { contextSlot: 10, amountRaw: balance }
    },
    getLatestBlockhash: async () => {
      calls.push('blockhash')
      return { contextSlot: 11, blockhash, lastValidBlockHeight: 99 }
    },
    getFeeForMessage: async messageBase64 => {
      calls.push(['fee', messageBase64])
      return { contextSlot: 12, feeLamports: '5000' }
    },
    simulateTransaction: async transactionBase64 => {
      calls.push(['simulate', transactionBase64])
      return { contextSlot: 13, unitsConsumed: 150 }
    }
  }
  return { rpc, calls }
}

function signingCommand(prepared) {
  const data = Buffer.alloc(12)
  data.writeUInt32LE(2, 0)
  data.writeBigUInt64LE(BigInt(prepared.lamports), 4)
  return {
    commandId: 'signing-command:solana:transfer',
    chainId: prepared.chainId,
    operation: 'transaction',
    summary: {
      schema: 'solana.transaction.v1',
      chainId: prepared.chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        messageVersion: 'legacy',
        feePayer: prepared.sender,
        recentBlockhash: prepared.recentBlockhash,
        requiredSigners: [prepared.sender],
        staticAccountKeys: [
          prepared.sender,
          prepared.recipient,
          '11111111111111111111111111111111'
        ],
        addressTableLookups: [],
        feeLamports: null,
        computeUnitLimit: null,
        computeUnitPriceMicroLamports: null,
        maximumPriorityFeeLamports: null,
        simulationStatus: 'not-run',
        simulationUnitsConsumed: null,
        instructions: [
          {
            index: 0,
            programId: '11111111111111111111111111111111',
            accounts: [
              { address: prepared.sender, signer: true, writable: true, source: 'static' },
              { address: prepared.recipient, signer: false, writable: true, source: 'static' }
            ],
            data: {
              encoding: 'base64',
              value: data.toString('base64'),
              byteLength: data.length,
              sha256: createHash('sha256').update(data).digest('hex')
            },
            interpretation: {
              kind: 'system-transfer',
              from: prepared.sender,
              to: prepared.recipient,
              lamports: prepared.lamports
            }
          }
        ]
      }
    },
    payloadFingerprint: {
      algorithm: 'sha256',
      digestHex: createHash('sha256')
        .update(Buffer.from(prepared.transactionBase64, 'base64'))
        .digest('hex')
    },
    execution: { kind: 'internal' },
    expiresAt: 2_000
  }
}

test.describe('Solana transfer preparer', () => {
  test('attests the chain, quotes the exact wire message and simulates before approval', async () => {
    const state = harness()
    const prepared = await prepareSolanaNativeTransfer({
      chainId: SOLANA_NETWORKS.devnet.chainId,
      sender,
      recipient,
      lamports: '5000',
      rpc: state.rpc
    })

    expect(prepared).toMatchObject({
      chainId: SOLANA_NETWORKS.devnet.chainId,
      sender,
      recipient,
      lamports: '5000',
      feeLamports: '5000',
      totalDebitLamports: '10000',
      recentBlockhash: blockhash,
      lastValidBlockHeight: 99,
      simulationUnitsConsumed: 150
    })
    expect(state.calls[0]).toBe('attest')
    expect(state.calls.slice(1, 3)).toEqual([['balance', sender], 'blockhash'])
    expect(state.calls[3]).toEqual(['fee', prepared.messageBase64])
    expect(state.calls[4]).toEqual(['simulate', prepared.transactionBase64])
    expect(parsePreparedSolanaNativeTransfer(structuredClone(prepared))).toEqual(prepared)
    expect(() =>
      parsePreparedSolanaNativeTransfer({ ...prepared, totalDebitLamports: '9999' })
    ).toThrow(/debit/)
    expect(() =>
      parsePreparedSolanaNativeTransfer({ ...prepared, transactionBase64: 'AQ==' })
    ).toThrow(/bytes/)
    await expect(
      assertSolanaTransferSigningMatchesPrepared(prepared, signingCommand(prepared))
    ).resolves.toBeUndefined()
    await expect(
      assertSolanaTransferSigningMatchesPrepared(prepared, {
        ...signingCommand(prepared),
        summary: {
          ...signingCommand(prepared).summary,
          fields: {
            ...signingCommand(prepared).summary.fields,
            instructions: [
              {
                ...signingCommand(prepared).summary.fields.instructions[0],
                interpretation: {
                  ...signingCommand(prepared).summary.fields.instructions[0].interpretation,
                  to: sender
                }
              }
            ]
          }
        }
      })
    ).rejects.toThrow(/summary/)
  })

  test('rejects insufficient funds before simulation', async () => {
    const state = harness('9999')
    await expect(
      prepareSolanaNativeTransfer({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        sender,
        recipient,
        lamports: '5000',
        rpc: state.rpc
      })
    ).rejects.toMatchObject({ code: 'insufficient-funds' })
    expect(state.calls.some(call => Array.isArray(call) && call[0] === 'simulate')).toBe(false)
  })

  test('preserves RPC failures and exposes a typed local balance failure', async () => {
    const state = harness('1')
    try {
      await prepareSolanaNativeTransfer({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        sender,
        recipient,
        lamports: '1',
        rpc: state.rpc
      })
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(SolanaTransferError)
    }

    const rpcFailure = new Error('rpc unavailable')
    await expect(
      prepareSolanaNativeTransfer({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        sender,
        recipient,
        lamports: '1',
        rpc: { ...state.rpc, assertExpectedChain: async () => Promise.reject(rpcFailure) }
      })
    ).rejects.toBe(rpcFailure)
  })

  test('prepares a listed SPL token transfer with an idempotent recipient ATA', async () => {
    const state = harness()
    const mint = 'SysvarRecentB1ockHashes11111111111111111111'
    const sourceTokenAccount = 'SysvarC1ock11111111111111111111111111111111'
    state.rpc.getTokenAccountsByMints = async () => ({
      contextSlot: 10,
      accounts: [
        {
          accountAddress: sourceTokenAccount,
          program: 'legacy',
          mint,
          owner: sender,
          state: 'initialized',
          isNative: false,
          amountRaw: '2000000',
          decimals: 6
        }
      ]
    })

    const prepared = await prepareSolanaTokenTransfer({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      assetId: `${SOLANA_NETWORKS.mainnet.chainId}/token:${mint}`,
      sender,
      recipient,
      mint,
      decimals: 6,
      amountRaw: '1500000',
      rpc: state.rpc
    })

    expect(prepared).toMatchObject({
      kind: 'token',
      mint,
      sourceTokenAccount,
      amountRaw: '1500000',
      decimals: 6,
      feeLamports: '5000'
    })
    expect(prepared.destinationTokenAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    expect(parsePreparedSolanaTokenTransfer(structuredClone(prepared))).toEqual(prepared)
    expect(() =>
      parsePreparedSolanaTokenTransfer({ ...prepared, destinationTokenAccount: recipient })
    ).toThrow(/bytes/)
  })
})
