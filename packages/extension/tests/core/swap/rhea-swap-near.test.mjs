import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { expect } from '@playwright/test'

import { RheaSwapNearCoordinator } from '../../../src/background/rhea-swap-near.ts'
import { NearRpcError } from '../../../src/infrastructure/chains/near/near-rpc-client.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'

const sender = 'alice.near'
const sourceHashes = ['1'.repeat(32), `${'1'.repeat(31)}2`]
const fingerprints = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]

function binding(native = false) {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:near-one',
    executionId: 'execution-near-one',
    router: 'near-intents',
    sourceTarget: 'router.near',
    sender,
    originAmountRaw: '1000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId: 'near:mainnet',
      assetId: native ? 'near:mainnet/slip44:397' : 'near:mainnet/nep141:wrap.near',
      protocolChainId: 'near',
      protocolAssetId: native ? 'native' : 'nep141:wrap.near'
    },
    destination: {
      chainId: 'zcash:mainnet',
      assetId: 'zcash:mainnet/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
}

function plan() {
  return {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    chain: 'near',
    tokenIn: 'wrap.near',
    amountIn: '1000',
    transactions: [
      {
        signerId: sender,
        receiverId: 'router.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'swap',
              args: { amount: '1000' },
              gas: '1000000000000',
              deposit: '1'
            }
          }
        ]
      },
      {
        signerId: sender,
        receiverId: 'recipient.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'ft_transfer',
              args: { receiver_id: 'recipient.near', amount: '2' },
              gas: '30000000000000',
              deposit: '1'
            }
          }
        ]
      }
    ]
  }
}

function accountScope() {
  return { keyDomainId: 'wallet:near', accountId: 'account:near' }
}

function activeContext() {
  return {
    accountIndex: 0,
    publicKey: `ed25519:${'1'.repeat(32)}`,
    keyDomainSource: { kind: 'mnemonic' },
    chainAccount: {
      id: 'chain-account-near',
      scope: {
        keyDomainId: 'wallet:near',
        accountId: 'account:near',
        chainId: 'near:mainnet'
      },
      identity: { kind: 'account-identifier', value: sender }
    }
  }
}

function createStore() {
  const values = new Map()
  return {
    values,
    async get(handle) {
      return values.get(handle) ?? null
    },
    async list() {
      return [...values.values()]
    },
    async put(value) {
      values.set(value.quoteHandle, value)
    },
    async delete(handle) {
      values.delete(handle)
    }
  }
}

function createHarness(overrides = {}) {
  let now = 1_000
  let id = 0
  let preparedIndex = 0
  let confirmedIndex = 0
  const calls = []
  const preparedTransactions = []
  const store = createStore()
  const repository = new InMemoryTransactionRepository()
  const submission = {
    quoteHandle: binding().quoteHandle,
    executionId: binding().executionId,
    router: 'near-intents',
    sourceHash: sourceHashes[1],
    orderId: 'order-near-one',
    statusChainId: 'near',
    reportStatus: 'pending'
  }
  const service = {
    async readNearTransactionBatchPlan() {
      calls.push('read-plan')
      return plan()
    },
    async recordTransactionSubmission(_handle, sourceHash) {
      calls.push(`record:${sourceHash}`)
      return submission
    },
    async reportSubmission() {
      calls.push('report')
      return submission
    },
    async discard() {
      calls.push('discard')
    },
    async readPreparedBuild() {
      return { request: {}, fromChain: 'near', toChain: 'near', raw: {}, execution: {} }
    },
    ...overrides.service
  }
  const signer = {
    async prepare(_keyDomainId, payload) {
      const index = preparedIndex++
      calls.push(`prepare:${index}`)
      preparedTransactions.push(payload.transaction)
      return {
        commandId: `command-near-${index}`,
        chainId: 'near:mainnet',
        operation: 'transaction',
        summary: {
          schema: 'near.transaction.v1',
          chainId: 'near:mainnet',
          operation: 'transaction',
          review: { level: 'standard', issues: [] },
          fields: {
            signerId: sender,
            publicKey: activeContext().publicKey,
            nonce: payload.transaction.nonce,
            receiverId: payload.transaction.receiverId,
            blockHash: '1'.repeat(32),
            actions: []
          }
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprints[index] },
        execution: overrides.ledger
          ? { kind: 'external', request: { encoding: 'base64', value: 'AQ==' } }
          : { kind: 'internal' },
        expiresAt: 5_000
      }
    },
    async confirm() {
      const index = confirmedIndex++
      calls.push(`confirm:${index}`)
      return {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: index === 0 ? 'AQ==' : 'Ag==' },
        transactionId: sourceHashes[index]
      }
    },
    async cancel(_keyDomainId, commandId) {
      calls.push(`cancel:${commandId}`)
    },
    ...overrides.signer
  }
  const rpc = {
    async assertExpectedChain() {
      calls.push('assert-chain')
    },
    async getAccessKey() {
      calls.push('access-key')
      return {
        accountId: sender,
        publicKey: activeContext().publicKey,
        nonce: '40',
        permission: { kind: 'full-access' },
        blockHash: '1'.repeat(32),
        blockHeight: 10
      }
    },
    async getFungibleTokenBalance() {
      calls.push('wrapped-balance')
      return { contractId: 'wrap.near', accountId: sender, amountRaw: '1000' }
    },
    async isFungibleTokenAccountRegistered() {
      calls.push('wrapped-registration')
      return true
    },
    async getAccount(accountId) {
      calls.push('native-balance')
      return {
        accountId,
        amountRaw: '9'.repeat(30),
        lockedRaw: '0',
        storageUsage: 0,
        codeHash: '1'.repeat(32),
        blockHash: '1'.repeat(32),
        blockHeight: 1
      }
    },
    async getGasPrice() {
      calls.push('gas-price')
      return '100000000'
    },
    async getNativeTransferCostConfig() {
      calls.push('protocol-costs')
      return nearCostConfig()
    },
    async broadcastSignedTransactionAndWait(transaction) {
      const index = transaction === 'AQ==' ? 0 : 1
      calls.push(`broadcast:${index}`)
      return {
        transaction: { hash: sourceHashes[index] },
        status: { SuccessValue: '' }
      }
    },
    async getTransactionStatus() {
      calls.push('status')
      return { status: 'unknown' }
    },
    ...overrides.rpc
  }
  const coordinator = new RheaSwapNearCoordinator({
    service,
    signer,
    rpc,
    pending: store,
    repository,
    loadContext:
      overrides.loadContext ??
      (async () => ({
        ...activeContext(),
        ...(overrides.ledger ? { keyDomainSource: { kind: 'hardware', vendor: 'ledger' } } : {})
      })),
    scheduleMonitoring: async () => calls.push('schedule'),
    now: () => now,
    createId: () => `stable-near-${++id}`
  })
  return {
    coordinator,
    calls,
    preparedTransactions,
    repository,
    store,
    setNow(value) {
      now = value
    }
  }
}

test('signs and broadcasts every NEAR transaction before reporting the final hash', async () => {
  const harness = createHarness()
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())

  expect(review.summaries).toHaveLength(2)
  const result = await harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  expect(result.graph.root.status).toBe('broadcast')
  expect(
    result.graph.segments
      .filter(segment => segment.role === 'origin')
      .map(segment => segment.evidence.transactionHash)
  ).toEqual(sourceHashes)
  expect(harness.calls).toContain(`record:${sourceHashes[1]}`)
  expect(harness.calls.indexOf('broadcast:1')).toBeLessThan(
    harness.calls.indexOf(`record:${sourceHashes[1]}`)
  )
  expect(() => assertPersistableTransactionGraph(result.graph)).not.toThrow()
  expect(harness.store.values.size).toBe(0)
})

test('recovers a partially broadcast signed batch without signing again after expiry', async () => {
  let allowSecondBroadcast = false
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`broadcast:${index}`)
        if (index === 1 && !allowSecondBroadcast) throw new Error('response unavailable')
        return {
          transaction: { hash: sourceHashes[index] },
          status: { SuccessValue: '' }
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/transaction 2 is signed and waiting to broadcast/)
  expect(harness.calls.filter(call => call.startsWith('record:'))).toHaveLength(0)

  const [pending] = await harness.store.list()
  expect(pending.signedTransactions).toHaveLength(2)
  const graph = await harness.repository.get(pending.scope, `tx:rhea-near:${pending.graphSuffix}`)
  expect(graph.segments.filter(segment => segment.role === 'origin')).toMatchObject([
    { status: 'broadcast', evidence: { transactionHash: sourceHashes[0] } },
    { status: 'signed', evidence: { transactionHash: sourceHashes[1] } }
  ])
  expect(() => assertPersistableTransactionGraph(graph)).not.toThrow()

  allowSecondBroadcast = true
  harness.setNow(6_000)
  await expect(harness.coordinator.recoverSigned()).resolves.toBe(1)
  expect(harness.calls.filter(call => call.startsWith('confirm:'))).toHaveLength(2)
  expect(harness.calls.filter(call => call === 'read-plan')).toHaveLength(2)
  expect(harness.calls.filter(call => call === 'broadcast:0')).toHaveLength(1)
  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([
    'broadcast:0',
    'broadcast:1',
    'broadcast:1'
  ])
  expect(harness.calls.indexOf('broadcast:1')).toBeLessThan(
    harness.calls.lastIndexOf(`record:${sourceHashes[1]}`)
  )
})

test('does not report a NEAR swap when a commit has no execution result', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`broadcast:${index}`)
        return { transaction: { hash: sourceHashes[index] }, status: {} }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/did not execute/)

  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual(['broadcast:0'])
  expect(harness.calls.filter(call => call.startsWith('record:'))).toHaveLength(0)
  expect(harness.store.values.size).toBe(0)
  const graph = await harness.repository.get(accountScope(), 'tx:rhea-near:stable-near-1')
  expect(graph.root.status).toBe('failed')
  expect(graph.segments.filter(segment => segment.role === 'origin')).toMatchObject([
    { status: 'failed', failure: { code: 'invalid' } },
    { status: 'signed' }
  ])
})

test('stops the batch when a committed NEAR transaction fails', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait(transaction) {
        const index = transaction === 'AQ==' ? 0 : 1
        harness.calls.push(`broadcast:${index}`)
        if (index === 0) {
          return { transaction: { hash: sourceHashes[index] }, status: { SuccessValue: '' } }
        }
        return {
          transaction: { hash: sourceHashes[index] },
          status: {
            Failure: {
              ActionError: {
                kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } }
              }
            }
          }
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/Smart contract panicked/)

  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([
    'broadcast:0',
    'broadcast:1'
  ])
  expect(harness.calls.filter(call => call.startsWith('record:'))).toHaveLength(0)
  expect(harness.store.values.size).toBe(0)
  const graph = await harness.repository.get(accountScope(), 'tx:rhea-near:stable-near-1')
  expect(graph.root.status).toBe('failed')
  expect(graph.segments.filter(segment => segment.role === 'origin')).toMatchObject([
    { status: 'broadcast', evidence: { transactionHash: sourceHashes[0] } },
    {
      status: 'failed',
      failure: { code: 'reverted' },
      evidence: { transactionHash: sourceHashes[1] }
    }
  ])
})

test('stops the batch when NEAR rejects the first signed transaction', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait() {
        harness.calls.push('broadcast:0')
        throw new NearRpcError('rpc-error', 'NEAR RPC request failed')
      },
      async getTransactionStatus() {
        harness.calls.push('status')
        return { status: 'unknown' }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('NEAR RPC request failed')

  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual(['broadcast:0'])
  expect(harness.calls.filter(call => call.startsWith('record:'))).toHaveLength(0)
  expect(harness.store.values.size).toBe(0)
  const graph = await harness.repository.get(accountScope(), 'tx:rhea-near:stable-near-1')
  expect(graph.segments.filter(segment => segment.role === 'origin')[0]).toMatchObject({
    status: 'failed',
    failure: { code: 'invalid' },
    evidence: { transactionHash: sourceHashes[0] }
  })
})

test('cancels every unsigned NEAR command and discards the quote', async () => {
  const harness = createHarness()
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  await harness.coordinator.cancel(binding().quoteHandle)

  expect(harness.calls).toContain('cancel:command-near-0')
  expect(harness.calls).toContain('cancel:command-near-1')
  expect(harness.calls).toContain('discard')
  expect(harness.store.values.size).toBe(0)
})

test('Ledger NEAR review binds the batch and prevents concurrent confirmation', async () => {
  let changed = false
  let releaseSigning
  const signingGate = new Promise(resolve => {
    releaseSigning = resolve
  })
  const harness = createHarness({
    ledger: true,
    service: {
      async readNearTransactionBatchPlan() {
        harness.calls.push('read-plan')
        const current = plan()
        if (changed) current.transactions[1].actions[0].params.deposit = '3'
        return current
      }
    },
    signer: {
      async confirm(_keyDomainId, commandId) {
        const index = Number(commandId.at(-1))
        harness.calls.push(`confirm:${index}`)
        await signingGate
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: index === 0 ? 'AQ==' : 'Ag==' },
          transactionId: sourceHashes[index]
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  changed = true
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/changed after Ledger review/)
  expect(harness.calls).not.toContain('confirm:0')

  changed = false
  const first = harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/already in progress/)
  releaseSigning()
  await expect(first).resolves.toMatchObject({ graph: { root: { status: 'broadcast' } } })
  expect(harness.calls.filter(call => call.startsWith('confirm:'))).toHaveLength(2)
})

test('Ledger NEAR confirms a persisted transaction-only fingerprint and the prior expanded fingerprint', async () => {
  for (const expanded of [false, true]) {
    const harness = createHarness({ ledger: true })
    const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
    const [pending] = await harness.store.list()
    const fingerprintInput = expanded
      ? { tokenIn: plan().tokenIn, amountIn: plan().amountIn, transactions: plan().transactions }
      : plan().transactions
    const expected = createHash('sha256')
      .update(JSON.stringify([JSON.stringify(fingerprintInput)]))
      .digest('hex')
    if (!expanded) expect(pending.planFingerprint).toBe(expected)
    if (expanded) await harness.store.put({ ...pending, planFingerprint: expected })
    await expect(
      harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
    ).resolves.toMatchObject({ graph: { root: { status: 'broadcast' } } })
  }
})

test('native NEAR prepends the wrapped shortfall and registration deposit before signer review', async () => {
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '400' }
      },
      async isFungibleTokenAccountRegistered() {
        return false
      }
    }
  })
  const review = await harness.coordinator.prepare(binding(true).quoteHandle, binding(true))

  expect(review.summaries).toHaveLength(3)
  expect(harness.preparedTransactions.map(transaction => transaction.receiverId)).toEqual([
    'wrap.near',
    'router.near',
    'recipient.near'
  ])
  expect(harness.preparedTransactions[0].actions).toEqual([
    {
      type: 'functionCall',
      methodName: 'near_deposit',
      args: 'e30=',
      gas: '50000000000000',
      depositYocto: '1250000000000000000600'
    }
  ])
  expect(harness.preparedTransactions.map(transaction => transaction.nonce)).toEqual([
    '41',
    '42',
    '43'
  ])
})

test('explicit wrap.near input does not prepend near_deposit', async () => {
  let balanceReads = 0
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        balanceReads += 1
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '400' }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  expect(review.summaries).toHaveLength(2)
  expect(harness.preparedTransactions.map(transaction => transaction.receiverId)).toEqual([
    'router.near',
    'recipient.near'
  ])
  expect(
    harness.preparedTransactions.some(transaction =>
      transaction.actions.some(action => action.methodName === 'near_deposit')
    )
  ).toBe(false)
  expect(balanceReads).toBe(1)
  expect(harness.preparedTransactions[1].actions[0]).toMatchObject({
    methodName: 'ft_transfer',
    depositYocto: '1'
  })
})

test('wNEAR drops native funding and keeps the fungible transfer at one yocto', async () => {
  const funded = plan()
  funded.transactions = [
    {
      signerId: sender,
      receiverId: 'wrap.near',
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'storage_deposit',
            args: { account_id: 'intents.near', registration_only: true },
            gas: '50000000000000',
            deposit: '1250000000000000000000'
          }
        },
        {
          type: 'FunctionCall',
          params: {
            methodName: 'near_deposit',
            args: {},
            gas: '50000000000000',
            deposit: '1129706865694300000000000'
          }
        },
        {
          type: 'FunctionCall',
          params: {
            methodName: 'ft_transfer',
            args: { receiver_id: 'intents.near', amount: '1000' },
            gas: '30000000000000',
            deposit: '1129706865694300000000001'
          }
        }
      ]
    },
    {
      signerId: sender,
      receiverId: 'someone.near',
      actions: [{ type: 'Transfer', params: { deposit: '1129706865694300000000000' } }]
    }
  ]
  const harness = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        return funded
      }
    }
  })
  await harness.coordinator.prepare(binding().quoteHandle, binding())
  expect(harness.preparedTransactions).toHaveLength(1)
  expect(harness.preparedTransactions[0].receiverId).toBe('wrap.near')
  expect(harness.preparedTransactions[0].actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'ft_transfer'
  ])
  expect(harness.preparedTransactions[0].actions[0].depositYocto).toBe('1250000000000000000000')
  expect(harness.preparedTransactions[0].actions[1].depositYocto).toBe('1')
  expect(harness.calls).not.toContain('broadcast:0')
})

test('wNEAR fails before signing when the fungible balance cannot cover the transfer', async () => {
  const funded = plan()
  funded.transactions[1].actions[0].params.deposit = '5000'
  funded.transactions[1].actions[0].params.args.amount = '1001'
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        harness.calls.push('wrapped-balance')
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '1000' }
      }
    },
    service: {
      async readNearTransactionBatchPlan() {
        return funded
      }
    }
  })
  await expect(harness.coordinator.prepare(binding().quoteHandle, binding())).rejects.toThrow(
    'wNEAR balance is insufficient'
  )
  expect(harness.calls).not.toContain('prepare:0')
  expect(harness.calls).not.toContain('broadcast:0')
})

test('reports the NEAR balance rejection and does not submit the swap', async () => {
  const harness = createHarness({
    rpc: {
      async broadcastSignedTransactionAndWait() {
        harness.calls.push('broadcast:0')
        throw new NearRpcError(
          'rpc-error',
          'Not enough NEAR. Available 0.110042 NEAR. Required 1.129707 NEAR.'
        )
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow('Not enough NEAR. Available 0.110042 NEAR. Required 1.129707 NEAR.')
  expect(harness.calls.filter(call => call.startsWith('record:'))).toHaveLength(0)
  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual(['broadcast:0'])
  expect(harness.store.values.size).toBe(0)
  const graph = await harness.repository.get(accountScope(), 'tx:rhea-near:stable-near-1')
  expect(graph.root.status).toBe('failed')
})

test('unrelated NEAR FT skips wNEAR funding and mismatched wrap bindings fail before signing', async () => {
  const otherAsset = binding()
  otherAsset.origin.assetId = 'near:mainnet/nep141:usdc.near'
  otherAsset.origin.protocolAssetId = 'nep141:usdc.near'
  const otherPlan = { ...plan(), tokenIn: 'usdc.near' }
  const otherHarness = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        return otherPlan
      }
    }
  })
  await otherHarness.coordinator.prepare(otherAsset.quoteHandle, otherAsset)
  expect(otherHarness.calls).not.toContain('wrapped-balance')
  expect(otherHarness.preparedTransactions).toHaveLength(2)

  const wrongFtSource = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        return plan()
      }
    }
  })
  await expect(
    wrongFtSource.coordinator.prepare(otherAsset.quoteHandle, otherAsset)
  ).rejects.toThrow(/quote source does not match/)

  for (const changed of [
    { origin: { ...binding().origin, protocolAssetId: 'nep141:usdc.near' } },
    { origin: { ...binding().origin, chainId: 'near:testnet' } }
  ]) {
    const invalid = { ...binding(), ...changed }
    const harness = createHarness()
    await expect(harness.coordinator.prepare(invalid.quoteHandle, invalid)).rejects.toThrow()
    expect(harness.calls).not.toContain('prepare:0')
  }
  const wrongSource = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        return { ...plan(), tokenIn: 'native' }
      }
    }
  })
  await expect(wrongSource.coordinator.prepare(binding().quoteHandle, binding())).rejects.toThrow(
    /quote source does not match/
  )
})

test('legacy Ledger review rejects a changed wrap.near quote source before confirmation', async () => {
  let tokenIn = 'wrap.near'
  const harness = createHarness({
    ledger: true,
    service: {
      async readNearTransactionBatchPlan() {
        return { ...plan(), tokenIn }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding().quoteHandle, binding())
  tokenIn = 'native'
  await expect(
    harness.coordinator.confirm(binding().quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/quote source does not match/)
  expect(harness.calls).not.toContain('confirm:0')
})

test('native NEAR records the final swap hash after broadcasting the wrap', async () => {
  let confirmed = 0
  const hashes = [...sourceHashes, `${'1'.repeat(31)}3`]
  const payloads = ['AQ==', 'Ag==', 'Aw==']
  const harness = createHarness({
    signer: {
      async confirm() {
        const index = confirmed++
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: payloads[index] },
          transactionId: hashes[index]
        }
      }
    },
    rpc: {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '0' }
      },
      async broadcastSignedTransactionAndWait(transaction) {
        const index = payloads.indexOf(transaction)
        harness.calls.push(`broadcast:${index}`)
        return {
          transaction: { hash: hashes[index] },
          status: { SuccessValue: '' }
        }
      }
    }
  })
  const review = await harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
  const result = await harness.coordinator.confirm(
    binding(true).quoteHandle,
    review.payloadFingerprint
  )

  expect(result.graph.segments.filter(segment => segment.role === 'origin')).toHaveLength(3)
  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([
    'broadcast:0',
    'broadcast:1',
    'broadcast:2'
  ])
  expect(harness.calls).toContain(`record:${hashes[2]}`)
  expect(harness.calls.indexOf('broadcast:2')).toBeLessThan(
    harness.calls.indexOf(`record:${hashes[2]}`)
  )
})

test('native NEAR uses sufficient existing wNEAR without another deposit', async () => {
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '1000' }
      }
    }
  })
  await harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
  expect(harness.preparedTransactions.map(transaction => transaction.receiverId)).toEqual([
    'router.near',
    'recipient.near'
  ])
})

function nearActionCost(gas = '0') {
  return { executionGas: gas, sendNotSirGas: gas, sendSirGas: gas }
}

function nearCostConfig(minGasPurchasePriceRaw = '100000000') {
  return {
    chainId: 'mainnet',
    minGasPurchasePriceRaw,
    storageAmountPerByteRaw: '10000000000000000000',
    actionReceiptCreation: nearActionCost(),
    transfer: nearActionCost(),
    functionCall: nearActionCost(),
    functionCallPerByte: nearActionCost()
  }
}

function nearAccount(accountId, amountRaw) {
  return {
    accountId,
    amountRaw,
    lockedRaw: '0',
    storageUsage: 0,
    codeHash: '1'.repeat(32),
    blockHash: '1'.repeat(32),
    blockHeight: 1
  }
}

test('native NEAR does not wrap when the minimum gas price makes the batch unaffordable', async () => {
  const balanceBetweenSpotAndMinimum = '20000000000000000000000'
  const unaffordableRpc = {
    async getFungibleTokenBalance() {
      return { contractId: 'wrap.near', accountId: sender, amountRaw: '0' }
    },
    async isFungibleTokenAccountRegistered() {
      return false
    },
    async getGasPrice() {
      return '100000000'
    },
    async getNativeTransferCostConfig() {
      return nearCostConfig('1000000000')
    },
    async getAccount(accountId) {
      return nearAccount(accountId, balanceBetweenSpotAndMinimum)
    }
  }
  const prepareHarness = createHarness({ rpc: unaffordableRpc })
  await expect(
    prepareHarness.coordinator.prepare(binding(true).quoteHandle, binding(true))
  ).rejects.toThrow(/^Not enough NEAR\. Available .+ NEAR\. Required .+ NEAR\.$/)
  expect(prepareHarness.calls).not.toContain('prepare:0')
  expect(prepareHarness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([])
  expect(prepareHarness.store.values.size).toBe(0)

  let amountRaw = '9'.repeat(30)
  const confirmHarness = createHarness({
    rpc: {
      ...unaffordableRpc,
      async getAccount(accountId) {
        return nearAccount(accountId, amountRaw)
      }
    }
  })
  const review = await confirmHarness.coordinator.prepare(
    binding(true).quoteHandle,
    binding(true)
  )
  expect(confirmHarness.preparedTransactions[0].actions[0].methodName).toBe('near_deposit')
  amountRaw = balanceBetweenSpotAndMinimum
  await expect(
    confirmHarness.coordinator.confirm(binding(true).quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/^Not enough NEAR\. Available .+ NEAR\. Required .+ NEAR\.$/)
  expect(confirmHarness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([])
  expect(confirmHarness.store.values.size).toBe(0)
})

test('native NEAR fails before signing when the account cannot pay the wrap', async () => {
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '0' }
      },
      async isFungibleTokenAccountRegistered() {
        return false
      },
      async getAccount(accountId) {
        return nearAccount(accountId, '1')
      }
    }
  })
  await expect(
    harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
  ).rejects.toThrow(/^Not enough NEAR\. Available .+ NEAR\. Required .+ NEAR\.$/)
  expect(harness.calls).not.toContain('prepare:0')
  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([])
  expect(harness.store.values.size).toBe(0)
})

test('native NEAR does not broadcast a signed wrap after the balance drops', async () => {
  let amountRaw = '9'.repeat(30)
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '0' }
      },
      async isFungibleTokenAccountRegistered() {
        return false
      },
      async getAccount(accountId) {
        return nearAccount(accountId, amountRaw)
      }
    }
  })
  const review = await harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
  expect(harness.preparedTransactions[0].actions[0].methodName).toBe('near_deposit')
  amountRaw = '1'
  await expect(
    harness.coordinator.confirm(binding(true).quoteHandle, review.payloadFingerprint)
  ).rejects.toThrow(/^Not enough NEAR\. Available .+ NEAR\. Required .+ NEAR\.$/)
  expect(harness.calls.filter(call => call.startsWith('broadcast:'))).toEqual([])
  expect(harness.store.values.size).toBe(0)
})

test('native NEAR accepts a sufficient first backend wrap without duplicating it', async () => {
  const wrappedPlan = plan()
  wrappedPlan.transactions.unshift({
    signerId: sender,
    receiverId: 'wrap.near',
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName: 'near_deposit', args: {}, gas: '50000000000000', deposit: '1000' }
      }
    ]
  })
  const harness = createHarness({
    rpc: {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: sender, amountRaw: '0' }
      }
    },
    service: {
      async readNearTransactionBatchPlan() {
        return wrappedPlan
      }
    }
  })
  await harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
  expect(harness.preparedTransactions.map(transaction => transaction.receiverId)).toEqual([
    'wrap.near',
    'router.near',
    'recipient.near'
  ])
})

test('native NEAR fails closed on insufficient or ambiguous existing wraps', async () => {
  for (const { deposit, args, receiverId, position, gas = '50000000000000', registered = true } of [
    { deposit: '999', args: {}, receiverId: 'wrap.near', position: 'first' },
    { deposit: '1000', args: { unexpected: true }, receiverId: 'wrap.near', position: 'first' },
    { deposit: '1000', args: {}, receiverId: 'other.near', position: 'first' },
    { deposit: '1000', args: {}, receiverId: 'wrap.near', position: 'last' },
    { deposit: '1000', args: {}, receiverId: 'wrap.near', position: 'first', gas: '1' },
    { deposit: '1000', args: {}, receiverId: 'wrap.near', position: 'first', registered: false }
  ]) {
    const wrappedPlan = plan()
    const transaction = {
      signerId: sender,
      receiverId,
      actions: [
        {
          type: 'FunctionCall',
          params: { methodName: 'near_deposit', args, gas, deposit }
        }
      ]
    }
    if (position === 'first') wrappedPlan.transactions.unshift(transaction)
    else wrappedPlan.transactions.push(transaction)
    const harness = createHarness({
      rpc: {
        async getFungibleTokenBalance() {
          return { contractId: 'wrap.near', accountId: sender, amountRaw: '0' }
        },
        async isFungibleTokenAccountRegistered() {
          return registered
        }
      },
      service: {
        async readNearTransactionBatchPlan() {
          return wrappedPlan
        }
      }
    })
    await expect(
      harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
    ).rejects.toThrow(/existing wrap/)
    expect(harness.calls).not.toContain('prepare:0')
  }
})

test('native NEAR refuses missing funding data and a mismatched quote source', async () => {
  for (const rpc of [
    {
      async getFungibleTokenBalance() {
        throw new Error('balance unavailable')
      }
    },
    {
      async isFungibleTokenAccountRegistered() {
        throw new Error('registration unavailable')
      }
    },
    {
      async getFungibleTokenBalance() {
        return { contractId: 'wrap.near', accountId: 'other.near', amountRaw: '0' }
      }
    }
  ]) {
    const harness = createHarness({ rpc })
    await expect(
      harness.coordinator.prepare(binding(true).quoteHandle, binding(true))
    ).rejects.toThrow()
    expect(harness.calls).not.toContain('prepare:0')
  }
  const wrongSource = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        return { ...plan(), tokenIn: 'fake.near' }
      }
    }
  })
  await expect(
    wrongSource.coordinator.prepare(binding(true).quoteHandle, binding(true))
  ).rejects.toThrow(/quote source does not match/)
  expect(wrongSource.calls).not.toContain('prepare:0')
})

test('explicit backend signer must match the active NEAR account', async () => {
  const mismatched = plan()
  mismatched.transactions[0].signerId = 'other.near'
  const harness = createHarness({
    service: {
      async readNearTransactionBatchPlan() {
        return mismatched
      }
    }
  })
  await expect(harness.coordinator.prepare(binding().quoteHandle, binding())).rejects.toThrow(
    /binding does not match/
  )
  expect(harness.calls).not.toContain('prepare:0')
})
