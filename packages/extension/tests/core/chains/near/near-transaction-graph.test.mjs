import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { createNearTransferGraph } from '../../../../src/infrastructure/chains/near/index.ts'

const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))

test('creates a NEAR transfer graph with the protocol maximum fee', () => {
  const prepared = {
    chainId: 'near:testnet',
    accountIndex: 0,
    signerId: '00'.repeat(32),
    publicKey: `ed25519:${'1'.repeat(32)}`,
    receiverId: 'alice.testnet',
    depositYocto: '2000000000000000000000000',
    estimatedFeeYocto: '44636512500000000000',
    maximumFeeYocto: '446365125000000000000',
    storageReserveYocto: '1000000000000000000000',
    totalRequiredYocto: '2001446365125000000000000',
    transaction: {
      chainId: 'near:testnet',
      accountIndex: 0,
      signerId: '00'.repeat(32),
      receiverId: 'alice.testnet',
      nonce: '42',
      blockHash: '11111111111111111111111111111111',
      actions: [{ type: 'transfer', depositYocto: '2000000000000000000000000' }]
    }
  }
  const graph = createNearTransferGraph({
    prepared,
    scope: { keyDomainId: 'key-domain:test', accountId: 'account:test' },
    transactionId: 'transaction:near:test',
    segmentId: 'segment:near:test',
    assets,
    createdAt: 1000
  })
  expect(graph.root.intent).toEqual({
    schemaVersion: 1,
    direction: 'outgoing',
    primaryAmount: {
      assetId: 'near:testnet/slip44:397',
      amountRaw: prepared.depositYocto
    },
    feeLimit: {
      assetId: 'near:testnet/slip44:397',
      amountRaw: prepared.maximumFeeYocto
    },
    sender: { chainId: 'near:testnet', address: prepared.signerId },
    recipient: { chainId: 'near:testnet', address: prepared.receiverId }
  })
  expect(graph.segments[0]).toMatchObject({
    status: 'prepared',
    target: { kind: 'onchain', chainId: 'near:testnet' },
    evidence: { requiredConfirmations: 1 }
  })
})
