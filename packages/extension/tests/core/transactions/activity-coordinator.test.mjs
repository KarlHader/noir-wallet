import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions,
  parseChainId
} from '../../../src/core/chains/registry/index.ts'
import {
  parseTransactionEventId,
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../src/core/transactions/domain/index.ts'
import { ActivityCoordinator } from '../../../src/infrastructure/activity/index.ts'
import { createEvmTransferGraph } from '../../../src/infrastructure/chains/evm/index.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/index.ts'

const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions('mainnet'))
const scope = { keyDomainId: 'wallet:activity', accountId: 'account:activity' }
const pointer = {
  schemaVersion: 2,
  generationId: 'metadata:generation:activity',
  sourceFingerprint: 'a'.repeat(64),
  committedAt: 1_000
}
const snapshot = {
  manifest: {
    schemaVersion: 2,
    generationId: pointer.generationId,
    status: 'verified',
    sourceFingerprint: pointer.sourceFingerprint,
    createdAt: 1_000,
    verifiedAt: 1_000,
    entityCounts: { keyDomains: 1, accounts: 1, chainAccounts: 0, addresses: 0 },
    activeAccount: scope
  },
  keyDomains: [],
  accounts: [],
  chainAccounts: [],
  addresses: []
}

function storage(overrides = {}) {
  return {
    getActivePointer: async () => pointer,
    getSnapshot: async () => snapshot,
    ...overrides
  }
}

function zcashTransaction(overrides = {}) {
  return {
    id: 'zcash-v1:activity',
    txHash: 'abc123',
    status: 'success',
    type: 'receive',
    amount: '0.5',
    to: 'u1recipient',
    from: '',
    fromType: 'shielded',
    fee: '0',
    timestamp: 1_200,
    network: 'mainnet',
    ...overrides
  }
}

async function repositoryWithEvmTransfer(transactionHash) {
  const repository = new InMemoryTransactionRepository()
  const graph = createEvmTransferGraph({
    prepared: {
      kind: 'native-transfer',
      chainId: parseChainId('eip155:1').id,
      addressIndex: 0,
      from: `0x${'1'.repeat(40)}`,
      assetId: 'eip155:1/slip44:60',
      recipient: `0x${'2'.repeat(40)}`,
      amountRaw: '1000000000000000000',
      observedBlockNumber: '100',
      transaction: {
        type: 'eip1559',
        chainId: '1',
        nonce: '1',
        maxFeePerGas: '5000000000',
        maxPriorityFeePerGas: '1000000000',
        gasLimit: '21000',
        to: `0x${'2'.repeat(40)}`,
        value: '1000000000000000000',
        input: '0x',
        accessList: []
      },
      createdAt: 1_100
    },
    scope,
    transactionId: parseTransactionId('transaction:evm:activity'),
    segmentId: parseTransactionSegmentId('segment:evm:activity'),
    assets
  })
  await repository.create(graph)
  if (transactionHash) {
    const result = await repository.applySegmentEvent({
      scope,
      transactionId: graph.root.id,
      segmentId: graph.segments[0].id,
      event: {
        id: parseTransactionEventId('event:evm:activity-broadcast'),
        status: 'broadcast',
        cause: 'progress',
        observedAt: 1_150,
        evidence: { transactionHash }
      },
      expectedRootRevision: 0,
      expectedSegmentRevision: 0
    })
    expect(result.status).toBe('applied')
  }
  return repository
}

function rpcActivity(transactionHash, overrides = {}) {
  return {
    id: `rpc:evm:${transactionHash}:native`,
    source: 'rpc',
    scope,
    kind: 'transfer',
    status: 'final',
    snapshot: {
      schemaVersion: 1,
      direction: 'incoming',
      primaryAmount: { assetId: 'eip155:1/slip44:60', amountRaw: '42' },
      sender: { chainId: 'eip155:1', address: `0x${'3'.repeat(40)}` },
      recipient: { chainId: 'eip155:1', address: `0x${'1'.repeat(40)}` }
    },
    segments: [
      {
        id: `rpc:evm:${transactionHash}:origin`,
        role: 'origin',
        target: { kind: 'onchain', chainId: 'eip155:1' },
        status: 'final',
        evidence: { transactionHash, blockHash: `0x${'b'.repeat(64)}`, blockHeight: 100 }
      }
    ],
    completeness: 'complete',
    createdAt: 1_300,
    updatedAt: 1_300,
    ...overrides
  }
}

test.describe('Activity coordinator', () => {
  test('reads the active Account partition and combines Zcash V1 with non-Zcash V2', async () => {
    const loadedScopes = []
    const coordinator = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: await repositoryWithEvmTransfer(),
      loadZcashTransactions: async activeScope => {
        loadedScopes.push(activeScope)
        return [zcashTransaction()]
      }
    })

    await expect(coordinator.readActive()).resolves.toMatchObject({
      scope,
      items: [
        { id: 'zcash-v1:activity', source: 'zcash-v1' },
        { id: 'transaction:evm:activity', source: 'wallet-v2' }
      ]
    })
    expect(loadedScopes).toEqual([scope])
  })

  test('returns null without an active generation or Account', async () => {
    const repository = await repositoryWithEvmTransfer()
    const noPointer = new ActivityCoordinator({
      storageRepository: storage({ getActivePointer: async () => null }),
      transactionRepository: repository,
      loadZcashTransactions: async () => []
    })
    await expect(noPointer.readActive()).resolves.toBeNull()

    const noAccount = new ActivityCoordinator({
      storageRepository: storage({
        getSnapshot: async () => ({
          ...snapshot,
          manifest: { ...snapshot.manifest, activeAccount: undefined }
        })
      }),
      transactionRepository: repository,
      loadZcashTransactions: async () => []
    })
    await expect(noAccount.readActive()).resolves.toBeNull()
  })

  test('adds external chain history and keeps the local transaction for a duplicate hash', async () => {
    const localHash = `0x${'a'.repeat(64)}`
    const remoteOnlyHash = `0x${'c'.repeat(64)}`
    const loadedRequests = []
    const coordinator = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: await repositoryWithEvmTransfer(localHash),
      loadZcashTransactions: async () => [],
      loadSupplementalItems: async (activeScope, accountMode, chainIds) => {
        loadedRequests.push({ activeScope, accountMode, chainIds })
        return [
          rpcActivity(localHash, { updatedAt: 9_000 }),
          rpcActivity(remoteOnlyHash, { createdAt: 1_400, updatedAt: 1_400 })
        ]
      }
    })

    const result = await coordinator.readActive({ chainIds: ['eip155:1'] })
    expect(loadedRequests).toEqual([
      { activeScope: scope, accountMode: 'main', chainIds: ['eip155:1'] }
    ])
    expect(result.items).toEqual([
      expect.objectContaining({ id: `rpc:evm:${remoteOnlyHash}:native`, source: 'rpc' }),
      expect.objectContaining({
        id: 'transaction:evm:activity',
        source: 'wallet-v2',
        status: 'final',
        segments: [
          expect.objectContaining({
            status: 'final',
            evidence: expect.objectContaining({ transactionHash: localHash, blockHeight: 100 })
          })
        ]
      })
    ])
    expect(result.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `rpc:evm:${localHash}:native` })])
    )
  })

  test('returns cached supplemental Activity without waiting for a remote refresh', async () => {
    let supplementalReads = 0
    let cachedSupplementalReads = 0
    const cachedHash = `0x${'d'.repeat(64)}`
    const coordinator = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: await repositoryWithEvmTransfer(),
      loadZcashTransactions: async () => [zcashTransaction()],
      loadSupplementalItems: async () => {
        supplementalReads += 1
        return []
      },
      loadCachedSupplementalItems: async () => {
        cachedSupplementalReads += 1
        return [rpcActivity(cachedHash)]
      }
    })

    const result = await coordinator.readActive({ includeSupplemental: false })
    expect(supplementalReads).toBe(0)
    expect(cachedSupplementalReads).toBe(1)
    expect(result.items).toEqual([
      expect.objectContaining({ id: `rpc:evm:${cachedHash}:native`, source: 'rpc' }),
      expect.objectContaining({ id: 'zcash-v1:activity', source: 'zcash-v1' }),
      expect.objectContaining({ id: 'transaction:evm:activity', source: 'wallet-v2' })
    ])
  })

  test('fails closed when the active pointer and snapshot do not match', async () => {
    const coordinator = new ActivityCoordinator({
      storageRepository: storage({
        getSnapshot: async () => ({
          ...snapshot,
          manifest: { ...snapshot.manifest, sourceFingerprint: 'b'.repeat(64) }
        })
      }),
      transactionRepository: await repositoryWithEvmTransfer(),
      loadZcashTransactions: async () => []
    })

    await expect(coordinator.readActive()).rejects.toThrow(/does not match/)
  })

  test('retains local transactions and cached history when supplemental refresh throws', async () => {
    const cachedHash = `0x${'d'.repeat(64)}`
    const coordinator = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: await repositoryWithEvmTransfer(),
      loadZcashTransactions: async () => [zcashTransaction()],
      loadSupplementalItems: async () => {
        throw new Error('History source unavailable')
      },
      loadCachedSupplementalItems: async () => [rpcActivity(cachedHash)]
    })

    const result = await coordinator.readActive()
    expect(result.items.map(item => item.id)).toEqual([
      `rpc:evm:${cachedHash}:native`,
      'zcash-v1:activity',
      'transaction:evm:activity'
    ])
  })

  test('retains local transactions when refresh, cache, and private address derivation fail', async () => {
    const coordinator = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: await repositoryWithEvmTransfer(),
      loadZcashTransactions: async () => [zcashTransaction()],
      loadSupplementalItems: async () => {
        throw new Error('History source unavailable')
      },
      loadCachedSupplementalItems: async () => {
        throw new Error('History cache unavailable')
      },
      loadPrivateExecutionAddresses: async () => {
        throw new Error('Signer unavailable')
      }
    })

    for (const includeSupplemental of [true, false]) {
      const result = await coordinator.readActive({ includeSupplemental })
      expect(result.items.map(item => item.id)).toEqual([
        'zcash-v1:activity',
        'transaction:evm:activity'
      ])
    }
  })

  test('does not hide authoritative transaction storage or account filtering failures', async () => {
    const coordinator = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: {
        list: async () => {
          throw new Error('Local transaction storage unavailable')
        }
      },
      loadZcashTransactions: async () => []
    })
    await expect(coordinator.readActive()).rejects.toThrow('Local transaction storage unavailable')

    const filtered = new ActivityCoordinator({
      storageRepository: storage(),
      transactionRepository: await repositoryWithEvmTransfer(),
      loadZcashTransactions: async () => [],
      filterLocalGraphs: async () => {
        throw new Error('Account filter unavailable')
      }
    })
    await expect(filtered.readActive()).rejects.toThrow('Account filter unavailable')
  })
})
