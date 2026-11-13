import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAccountId } from '../../../../src/core/accounts/domain/account.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/key-domain.ts'
import { ChromeSessionStarknetPendingTransferStore } from '../../../../src/infrastructure/chains/starknet/starknet-pending-transfer-store.ts'
import { STARKNET_OZ_CLASS_HASH } from '../../../../src/infrastructure/chains/starknet/starknet-primitives.ts'
import { StarknetRpcError } from '../../../../src/infrastructure/chains/starknet/starknet-rpc-types.ts'
import { StarknetTransferOrchestrator } from '../../../../src/infrastructure/chains/starknet/starknet-transfer-orchestrator.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'

const CHAIN_ID = 'starknet:SN_SEPOLIA'
const SENDER = '0x12'
const RECIPIENT = '0x34'
const ASSET_ID = 'starknet:SN_SEPOLIA/snip2:0x1'
const DEPLOY_HASH = '0x22'
const INVOKE_HASH = '0x44'

test('broadcasts deploy and invoke in the same approval', async () => {
  const rpc = fakeRpc()
  const orchestrator = orchestratorWith(rpc)
  const account = transferAccount()
  const review = await orchestrator.prepare(transferInput(account))
  const submission = await orchestrator.approve({
    account,
    transactionId: review.graph.root.id,
    payloadFingerprint: review.payloadFingerprint
  })
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy', 'invoke'])
  assert.equal(submission.status, 'broadcast')
  assert.deepEqual(
    submission.graph.segments.map(segment => segment.evidence?.transactionHash),
    [DEPLOY_HASH, INVOKE_HASH]
  )
})

test('a rejected early invoke is broadcast once after the deploy receipt', async () => {
  const receipts = [{ found: false, timedOut: false }]
  const rpc = fakeRpc({
    invokeError: new StarknetRpcError(
      'rpc-error',
      'Starknet RPC request failed',
      'Account is not deployed'
    ),
    receipt: () => receipts[0]
  })
  const orchestrator = orchestratorWith(rpc)
  const account = transferAccount()
  const review = await orchestrator.prepare(transferInput(account))
  const interrupted = await orchestrator.approve({
    account,
    transactionId: review.graph.root.id,
    payloadFingerprint: review.payloadFingerprint
  })
  assert.equal(interrupted.status, 'signed-pending-broadcast')
  const [pending] = await orchestrator.listPending()
  assert.equal(Boolean(pending?.signedInvoke), true)
  assert.equal(pending?.invokeHash, null)
  assert.equal(pending?.deployHash, DEPLOY_HASH)
  assert.equal(pending?.broadcastAttempted, false)
  await orchestrator.monitor()
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy'])
  receipts[0] = { found: true, finality: 'ACCEPTED_ON_L2', execution: 'SUCCEEDED' }
  await orchestrator.monitor()
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy', 'invoke'])
  await orchestrator.monitor()
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy', 'invoke'])
})

test('resumes a saved invoke once and does not submit a stored deploy again', async () => {
  const rpc = fakeRpc({
    invokeError: new StarknetRpcError(
      'rpc-error',
      'Starknet RPC request failed',
      'Account is not deployed'
    )
  })
  const orchestrator = orchestratorWith(rpc)
  const account = transferAccount()
  const review = await orchestrator.prepare(transferInput(account))
  const interrupted = await orchestrator.approve({
    account,
    transactionId: review.graph.root.id,
    payloadFingerprint: review.payloadFingerprint
  })
  assert.equal(interrupted.status, 'signed-pending-broadcast')
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy'])
  const resumed = await orchestrator.resume(account, review.graph.root.id)
  assert.equal(resumed.status, 'broadcast')
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy', 'invoke'])
  const again = await orchestrator.resume(account, review.graph.root.id)
  assert.equal(again.status, 'broadcast')
  assert.deepEqual(rpc.broadcasts.map(call => call.kind), ['deploy', 'invoke'])
})

test('persists a broadcast invoke and marks it final after the receipt', async () => {
  const repository = new InMemoryTransactionRepository()
  const rpc = fakeRpc({
    receipt: () => ({ found: true, finality: 'ACCEPTED_ON_L2', execution: 'SUCCEEDED' })
  })
  const orchestrator = orchestratorWith(rpc, repository)
  const account = transferAccount()
  const review = await orchestrator.prepare(transferInput(account))
  const scope = {
    keyDomainId: parseKeyDomainId('domain-1'),
    accountId: parseAccountId('account-1')
  }
  assert.equal(await repository.get(scope, review.graph.root.id), null)
  const submission = await orchestrator.approve({
    account,
    transactionId: review.graph.root.id,
    payloadFingerprint: review.payloadFingerprint
  })
  const broadcast = await repository.get(scope, submission.graph.root.id)
  assert.equal(broadcast?.root.status, 'broadcast')
  assert.equal(
    broadcast?.segments.find(segment => segment.id.endsWith(':invoke'))?.evidence?.transactionHash,
    INVOKE_HASH
  )
  await orchestrator.monitor()
  const finished = await repository.get(scope, submission.graph.root.id)
  assert.equal(finished?.root.status, 'final')
})

test('does not persist a Starknet transfer before the invoke is broadcast', async () => {
  const repository = new InMemoryTransactionRepository()
  const rpc = fakeRpc({
    invokeError: new StarknetRpcError(
      'rpc-error',
      'Starknet RPC request failed',
      'Account is not deployed'
    )
  })
  const orchestrator = orchestratorWith(rpc, repository)
  const account = transferAccount()
  const review = await orchestrator.prepare(transferInput(account))
  await orchestrator.approve({
    account,
    transactionId: review.graph.root.id,
    payloadFingerprint: review.payloadFingerprint
  })
  const scope = {
    keyDomainId: parseKeyDomainId('domain-1'),
    accountId: parseAccountId('account-1')
  }
  assert.equal(await repository.get(scope, review.graph.root.id), null)
})

function orchestratorWith(rpc, repository = new InMemoryTransactionRepository()) {
  return new StarknetTransferOrchestrator({
    rpc,
    builder: {
      async prepareDeploy(payload) {
        return preparation(payload, DEPLOY_HASH, 'deploy')
      },
      async prepareInvoke(payload) {
        return preparation(payload, INVOKE_HASH, 'invoke')
      }
    },
    signer: {
      async prepare(_keyDomainId, payload) {
        return { commandId: payload.kind === 'starknet-deploy-account' ? 'deploy' : 'invoke' }
      },
      async confirm(_keyDomainId, commandId) {
        return {
          transactionHash: commandId === 'deploy' ? DEPLOY_HASH : INVOKE_HASH,
          transaction: { version: '0x3', sender_address: SENDER }
        }
      }
    },
    pending: new ChromeSessionStarknetPendingTransferStore(memorySession()),
    repository,
    assets: {
      list() {
        return [{ asset: { kind: 'token', reference: '0x1', id: ASSET_ID } }]
      },
      get(id) {
        return id === ASSET_ID ? { asset: { id } } : undefined
      }
    },
    chainId: CHAIN_ID,
    feeTokenReference: '0x1',
    now: () => 1_700_000_000_000,
    createId: () => 'transfer-1'
  })
}

function fakeRpc(options = {}) {
  const broadcasts = []
  let invokeFailed = Boolean(options.invokeError)
  return {
    broadcasts,
    async getClassHashAt() {
      return null
    },
    async getNonce() {
      return 0n
    },
    async call() {
      return ['0xde0b6b3a7640000', '0x0']
    },
    async estimateFees() {
      return [feeEstimate(), feeEstimate()]
    },
    async getTransactionReceipt() {
      return options.receipt ? options.receipt() : { found: false, timedOut: false }
    },
    async getEvents() {
      return { events: [] }
    },
    async getBlockTimestamp() {
      return 1_700_000_000
    },
    async addDeployAccountTransaction(transaction) {
      broadcasts.push({ kind: 'deploy', version: transaction.version })
      return DEPLOY_HASH
    },
    async addInvokeTransaction(transaction) {
      if (invokeFailed) {
        invokeFailed = false
        throw options.invokeError
      }
      broadcasts.push({ kind: 'invoke', version: transaction.version })
      return INVOKE_HASH
    }
  }
}

function preparation(payload, signingHash, kind) {
  const summary =
    kind === 'deploy'
      ? {
          contractAddress: payload.accountAddress,
          classHash: payload.classHash,
          salt: payload.publicKey,
          constructorCalldata:
            payload.implementation === 'argent_v04'
              ? ['0x0', payload.publicKey, '0x1']
              : [payload.publicKey],
          nonce: payload.nonce,
          tip: '0',
          resourceBounds: payload.resourceBounds,
          nonceDataAvailabilityMode: 'l1',
          feeDataAvailabilityMode: 'l1'
        }
      : {
          senderAddress: payload.accountAddress,
          nonce: payload.nonce,
          tip: '0',
          resourceBounds: payload.resourceBounds,
          calls: payload.calls.map(call => ({
            to: call.to,
            selector: call.selector,
            entrypoint: null,
            calldata: [...call.calldata]
          })),
          nonceDataAvailabilityMode: 'l1',
          feeDataAvailabilityMode: 'l1'
        }
  return {
    account: { address: payload.accountAddress },
    signingHash,
    summary
  }
}

function feeEstimate() {
  return {
    l1GasConsumed: 1n,
    l1GasPrice: 1n,
    l2GasConsumed: 1n,
    l2GasPrice: 1n,
    l1DataGasConsumed: 1n,
    l1DataGasPrice: 1n,
    overallFee: 3n
  }
}

function transferAccount() {
  return {
    accountIndex: 2,
    addressIndex: 0,
    keyDomainSource: { kind: 'software' },
    publicKey: '0x2',
    classHash: STARKNET_OZ_CLASS_HASH,
    chainAccount: {
      id: 'chain-account-1',
      scope: { keyDomainId: 'domain-1', accountId: 'account-1', chainId: CHAIN_ID },
      derivation: { path: "m/44'/9004'/2'/0/0" },
      identity: { kind: 'account-identifier', value: SENDER },
      createdAt: 1
    }
  }
}

function transferInput(account) {
  return {
    account,
    assetId: ASSET_ID,
    tokenReference: '0x1',
    recipient: RECIPIENT,
    amountRaw: '1000'
  }
}

function memorySession() {
  const data = new Map()
  return {
    async get(keys) {
      if (keys === null) return Object.fromEntries(data)
      return data.has(keys) ? { [keys]: data.get(keys) } : {}
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    },
    async remove(keys) {
      for (const key of [keys].flat()) data.delete(key)
    }
  }
}
