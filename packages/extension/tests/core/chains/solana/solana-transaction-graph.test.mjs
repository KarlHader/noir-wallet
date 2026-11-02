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

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))
const prepared = {
  chainId,
  sender,
  recipient,
  lamports: '5000',
  feeLamports: '5000',
  totalDebitLamports: '10000',
  recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
  lastValidBlockHeight: 99,
  transactionBase64: 'AQ==',
  messageBase64: 'AQ==',
  simulationUnitsConsumed: 150
}

test('creates an immutable Solana transfer snapshot with its quoted fee', () => {
  const graph = createSolanaTransferGraph({
    prepared,
    scope: { keyDomainId: 'key-domain:solana', accountId: 'account:solana:0' },
    transactionId: parseTransactionId('transaction:solana:graph'),
    segmentId: parseTransactionSegmentId('segment:solana:graph'),
    chainAccountId: 'chain-account:solana:0',
    assets,
    createdAt: 1_000
  })

  expect(graph).toMatchObject({
    root: {
      status: 'prepared',
      intent: {
        direction: 'outgoing',
        primaryAmount: { assetId: `${chainId}/slip44:501`, amountRaw: '5000' },
        feeLimit: { assetId: `${chainId}/slip44:501`, amountRaw: '5000' },
        sender: { chainId, address: sender },
        recipient: { chainId, address: recipient }
      }
    },
    segments: [
      {
        status: 'prepared',
        target: { kind: 'onchain', chainId, chainAccountId: 'chain-account:solana:0' },
        evidence: { requiredConfirmations: 1 }
      }
    ]
  })
})

test('rejects a non-Solana chain and a forged native asset definition', () => {
  const input = {
    prepared,
    scope: { keyDomainId: 'key-domain:solana', accountId: 'account:solana:0' },
    transactionId: parseTransactionId('transaction:solana:invalid'),
    segmentId: parseTransactionSegmentId('segment:solana:invalid'),
    assets,
    createdAt: 1_000
  }
  expect(() =>
    createSolanaTransferGraph({
      ...input,
      prepared: { ...prepared, chainId: 'near:testnet' }
    })
  ).toThrow(/Solana chain/)
  expect(() =>
    createSolanaTransferGraph({
      ...input,
      prepared: { ...prepared, feeLamports: '01' }
    })
  ).toThrow(/fee/)
})
