import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import { createSolanaTransferGraph } from '../../../../src/infrastructure/chains/solana/solana-transaction-graph.ts'
import {
  createSolanaWalletClient,
  SolanaWalletClientError
} from '../../../../src/popup/services/solana-wallet-client.ts'

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const blockhash = 'SysvarC1ock11111111111111111111111111111111'
const transactionId = parseTransactionId('transaction:solana:client')
const segmentId = parseTransactionSegmentId('segment:solana:client')
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))
const graph = createSolanaTransferGraph({
  prepared: {
    chainId,
    sender,
    recipient,
    lamports: '5000',
    feeLamports: '5000',
    totalDebitLamports: '10000',
    recentBlockhash: blockhash,
    lastValidBlockHeight: 99,
    transactionBase64: 'AQ==',
    messageBase64: 'AQ==',
    simulationUnitsConsumed: 150
  },
  scope: { keyDomainId: 'key-domain:solana', accountId: 'account:solana:0' },
  transactionId,
  segmentId,
  assets,
  createdAt: 1_000,
  chainAccountId: 'chain-account:solana:0'
})

function summary(overrides = {}) {
  const data = Buffer.alloc(12)
  data.writeUInt32LE(2, 0)
  data.writeBigUInt64LE(5_000n, 4)
  return {
    schema: 'solana.transaction.v1',
    chainId,
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      messageVersion: 'legacy',
      feePayer: sender,
      recentBlockhash: blockhash,
      requiredSigners: [sender],
      staticAccountKeys: [sender, recipient, '11111111111111111111111111111111'],
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
            { address: sender, signer: true, writable: true, source: 'static' },
            { address: recipient, signer: false, writable: true, source: 'static' }
          ],
          data: {
            encoding: 'base64',
            value: data.toString('base64'),
            byteLength: data.length,
            sha256: createHash('sha256').update(data).digest('hex')
          },
          interpretation: {
            kind: 'system-transfer',
            from: sender,
            to: overrides.recipient ?? recipient,
            lamports: '5000'
          }
        }
      ]
    }
  }
}

function review(overrides = {}) {
  return {
    graph,
    review: {
      chainId,
      operation: 'transaction',
      summary: summary(overrides),
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
      expiresAt: 5_000
    }
  }
}

test('sends an exact intent and accepts only a graph-bound Solana review', async () => {
  const messages = []
  const client = createSolanaWalletClient(async message => {
    messages.push(message)
    return { result: review() }
  })
  await expect(
    client.prepareTransfer({ assetId: `${chainId}/slip44:501`, recipient, amountRaw: '5000' })
  ).resolves.toMatchObject({
    graph: { root: { id: transactionId, status: 'prepared' } },
    review: { chainId, summary: { schema: 'solana.transaction.v1' } }
  })
  expect(messages).toEqual([
    {
      type: 'PREPARE_SOLANA_TRANSFER',
      intent: { assetId: `${chainId}/slip44:501`, recipient, amountRaw: '5000' }
    }
  ])

  const forged = createSolanaWalletClient(async () => ({
    result: review({ recipient: sender })
  }))
  await expect(
    forged.prepareTransfer({ assetId: `${chainId}/slip44:501`, recipient, amountRaw: '5000' })
  ).rejects.toMatchObject({ code: 'invalid-response' })
})

test('rejects malformed client inputs and non-canonical runtime errors', async () => {
  let calls = 0
  const client = createSolanaWalletClient(async () => {
    calls += 1
    return { result: review() }
  })
  await expect(
    client.prepareTransfer({ assetId: `${chainId}/slip44:501`, recipient, amountRaw: '0' })
  ).rejects.toBeInstanceOf(SolanaWalletClientError)
  expect(calls).toBe(0)

  const forgedError = createSolanaWalletClient(async () => ({
    error: { code: 'network-unavailable', message: 'retry this hidden endpoint' }
  }))
  await expect(
    forgedError.prepareTransfer({
      assetId: `${chainId}/slip44:501`,
      recipient,
      amountRaw: '5000'
    })
  ).rejects.toMatchObject({ code: 'invalid-response' })
})
