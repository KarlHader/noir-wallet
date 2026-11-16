import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { createNearTransferGraph } from '../../../../src/infrastructure/chains/near/index.ts'
import {
  createNearWalletClient,
  NearWalletClientError
} from '../../../../src/popup/services/near-wallet-client.ts'

const chainId = 'near:testnet'
const signerId = '00'.repeat(32)
const publicKey = `ed25519:${'1'.repeat(32)}`
const recipient = 'alice.testnet'
const blockHash = '11111111111111111111111111111111'
const amountRaw = '2000000000000000000000000'
const transactionId = 'transaction:near:client'
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))
const graph = createNearTransferGraph({
  prepared: {
    chainId,
    accountIndex: 0,
    signerId,
    publicKey,
    receiverId: recipient,
    depositYocto: amountRaw,
    estimatedFeeYocto: '44636512500000000000',
    maximumFeeYocto: '446365125000000000000',
    storageReserveYocto: '1000000000000000000000',
    totalRequiredYocto: '2001446365125000000000000',
    transaction: {
      chainId,
      accountIndex: 0,
      signerId,
      receiverId: recipient,
      nonce: '42',
      blockHash,
      actions: [{ type: 'transfer', depositYocto: amountRaw }]
    }
  },
  scope: { keyDomainId: 'key-domain:near', accountId: 'account:near:0' },
  transactionId,
  segmentId: 'segment:near:client',
  assets,
  createdAt: 1_000,
  chainAccountId: 'chain-account:near:0'
})

function review(receiverId = recipient) {
  return {
    graph,
    debit: {
      maximumFeeRaw: '446365125000000000000',
      storageReserveRaw: '1000000000000000000000'
    },
    review: {
      chainId,
      operation: 'transaction',
      summary: {
        schema: 'near.transaction.v1',
        chainId,
        operation: 'transaction',
        review: { level: 'standard', issues: [] },
        fields: {
          signerId,
          publicKey,
          nonce: '42',
          receiverId,
          blockHash,
          actions: [{ kind: 'transfer', depositYocto: amountRaw }]
        }
      },
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
      expiresAt: 5_000
    }
  }
}

test('sends an exact intent and accepts only a graph-bound NEAR review', async () => {
  const messages = []
  const client = createNearWalletClient(async message => {
    messages.push(message)
    return { result: review() }
  })
  await expect(
    client.prepareTransfer({ assetId: `${chainId}/slip44:397`, recipient, amountRaw })
  ).resolves.toMatchObject({
    graph: { root: { id: transactionId, status: 'prepared' } },
    debit: {
      maximumFeeRaw: '446365125000000000000',
      storageReserveRaw: '1000000000000000000000'
    },
    review: { chainId, summary: { schema: 'near.transaction.v1' } }
  })
  expect(messages).toEqual([
    {
      type: 'PREPARE_NEAR_TRANSFER',
      intent: { assetId: `${chainId}/slip44:397`, recipient, amountRaw }
    }
  ])

  const forged = createNearWalletClient(async () => ({ result: review('mallory.testnet') }))
  await expect(
    forged.prepareTransfer({ assetId: `${chainId}/slip44:397`, recipient, amountRaw })
  ).rejects.toMatchObject({ code: 'invalid-response' })

  const forgedDebit = createNearWalletClient(async () => ({
    result: { ...review(), debit: { maximumFeeRaw: '1', storageReserveRaw: '0' } }
  }))
  await expect(
    forgedDebit.prepareTransfer({ assetId: `${chainId}/slip44:397`, recipient, amountRaw })
  ).rejects.toMatchObject({ code: 'invalid-response' })
})

test('rejects malformed input and non-canonical runtime errors before UI use', async () => {
  let calls = 0
  const client = createNearWalletClient(async () => {
    calls += 1
    return { result: review() }
  })
  await expect(
    client.prepareTransfer({ assetId: `${chainId}/slip44:397`, recipient, amountRaw: '0' })
  ).rejects.toBeInstanceOf(NearWalletClientError)
  expect(calls).toBe(0)

  const forgedError = createNearWalletClient(async () => ({
    error: { code: 'network-unavailable', message: 'retry this hidden endpoint' }
  }))
  await expect(
    forgedError.prepareTransfer({ assetId: `${chainId}/slip44:397`, recipient, amountRaw })
  ).rejects.toMatchObject({ code: 'invalid-response' })
})

test('accepts a finalized NEAR activity item with a canonical Base58 transaction hash', async () => {
  const transactionHash = '8y5sRDBzJd2UtsvgRgG3TsJgFx6rMoHzRyaDVhmqhF5g'
  const client = createNearWalletClient(async message => {
    expect(message).toEqual({ type: 'GET_ACTIVITY', action: 'read' })
    return {
      result: {
        scope: graph.root.scope,
        items: [
          {
            id: graph.root.id,
            source: 'wallet-v2',
            scope: graph.root.scope,
            kind: graph.root.kind,
            status: 'final',
            snapshot: graph.root.intent,
            segments: graph.segments.map(segment => ({
              id: segment.id,
              role: segment.role,
              target: segment.target,
              status: 'final',
              evidence: { transactionHash, confirmations: 1, requiredConfirmations: 1 }
            })),
            completeness: 'complete',
            createdAt: graph.root.createdAt,
            updatedAt: graph.root.createdAt + 1
          }
        ],
        partialItemCount: 0
      }
    }
  })

  await expect(client.getTransferActivity(graph)).resolves.toEqual({
    status: 'final',
    updatedAt: graph.root.createdAt + 1,
    transactionHash,
    confirmations: 1,
    requiredConfirmations: 1
  })
})
