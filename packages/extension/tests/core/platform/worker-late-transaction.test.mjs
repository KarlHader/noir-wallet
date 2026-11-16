import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZcashWorkerClient, getRpcTimeout } from '../../../src/core/worker/client.ts'
import { TimeoutError } from '../../../src/lib/async-utils.ts'
import {
  applyZcashWorkerBroadcast,
  zcashWorkerBroadcastResult
} from '../../../src/lib/transaction-replacement.ts'
import {
  parseKeyringWorkerRpcRuntimeMessage,
  parseWorkerRpcRuntimeMessage
} from '../../../src/lib/runtime-message-security.ts'

const FIRST_HASH = 'a'.repeat(64)
const FINAL_HASH = 'b'.repeat(64)
const CONTEXT = { accountKey: 'mainnet_wallet-a_account-a', transactionId: 'tx-a' }

test('a timed-out transaction keeps its Worker response without terminating the Worker', async t => {
  const originalWorker = globalThis.Worker
  let worker
  globalThis.Worker = class {
    terminated = false
    constructor() {
      worker = this
    }
    postMessage(message) {
      this.message = message
    }
    terminate() {
      this.terminated = true
    }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    worker?.onerror?.({ preventDefault() {}, message: 'test cleanup' })
    t.mock.timers.reset()
    globalThis.Worker = originalWorker
  })

  const client = Object.create(ZcashWorkerClient.prototype)
  client.environment = 'offscreen'
  client.initDedup = { reset() {} }
  const late = []
  client.onLateTransactionResult = event => late.push(event)
  const pending = client.requestToWorker(
    'transaction.send',
    { walletId: 'wallet-a', accountIndex: 0, to: 'synthetic', amount: '1' },
    CONTEXT
  )
  const timedOut = assert.rejects(pending, TimeoutError)
  t.mock.timers.tick(getRpcTimeout('transaction.send'))
  await timedOut
  assert.equal(worker.terminated, false)

  const result = {
    status: 'success',
    txIds: [FIRST_HASH],
    finalTxId: FIRST_HASH,
    transactions: [{ txId: FIRST_HASH, status: 'submitted' }]
  }
  worker.onmessage({ data: { id: worker.message.id, method: 'transaction.send', result } })
  await Promise.resolve()
  assert.equal(late.length, 1)
  assert.equal(late[0].walletId, 'wallet-a')
  assert.deepEqual(late[0].transactionContext, CONTEXT)
  assert.deepEqual(late[0].response.result, result)
})

test('only complete Worker broadcasts supply a primary hash', () => {
  const complete = {
    status: 'success',
    txIds: [FIRST_HASH, FINAL_HASH],
    finalTxId: FINAL_HASH,
    transactions: [
      { txId: FIRST_HASH, status: 'submitted' },
      { txId: FINAL_HASH, status: 'submitted' }
    ]
  }
  assert.deepEqual(zcashWorkerBroadcastResult('transaction.send', complete), {
    txHash: FINAL_HASH,
    txHashes: [FIRST_HASH, FINAL_HASH]
  })
  assert.deepEqual(zcashWorkerBroadcastResult('transaction.oneclick_shield', FIRST_HASH), {
    txHash: FIRST_HASH,
    txHashes: [FIRST_HASH]
  })
  assert.equal(
    zcashWorkerBroadcastResult('transaction.send', {
      ...complete,
      status: 'partial',
      transactions: [complete.transactions[0], { txId: FINAL_HASH, status: 'rejected' }]
    }),
    null
  )
  assert.equal(
    zcashWorkerBroadcastResult('transaction.send', {
      ...complete,
      status: 'unknown',
      transactions: [complete.transactions[0], { txId: FINAL_HASH, status: 'unknown' }]
    }),
    null
  )
})

test('broadcast projection updates only the original live scoped record', () => {
  const original = { id: 'tx-a', network: 'mainnet', txHash: '', status: 'pending' }
  const result = { txHash: FINAL_HASH, txHashes: [FIRST_HASH, FINAL_HASH] }
  const applied = applyZcashWorkerBroadcast([original], CONTEXT, 'wallet-a', result)
  assert.equal(applied[0].txHash, FINAL_HASH)
  assert.deepEqual(applied[0].chainHashes, [
    { hash: FIRST_HASH, chain: 'Zcash' },
    { hash: FINAL_HASH, chain: 'Zcash' }
  ])
  assert.strictEqual(applyZcashWorkerBroadcast([], CONTEXT, 'wallet-a', result).length, 0)
  for (const record of [
    { ...original, network: 'testnet' },
    { ...original, txHash: FIRST_HASH },
    { ...original, status: 'success' },
    { ...original, status: 'failed' }
  ]) {
    const records = [record]
    assert.strictEqual(applyZcashWorkerBroadcast(records, CONTEXT, 'wallet-a', result), records)
  }
  const records = [original]
  assert.strictEqual(applyZcashWorkerBroadcast(records, CONTEXT, 'other-wallet', result), records)
  assert.strictEqual(
    applyZcashWorkerBroadcast(records, CONTEXT, 'wallet-a', {
      txHash: FIRST_HASH,
      txHashes: [FIRST_HASH, FINAL_HASH]
    }),
    records
  )
})

test('transaction context is accepted only on internal mutation RPCs', () => {
  const message = {
    type: 'KEYRING_WORKER_RPC',
    method: 'transaction.send',
    payload: { walletId: 'wallet-a' },
    transactionContext: CONTEXT
  }
  assert.deepEqual(parseKeyringWorkerRpcRuntimeMessage(message).transactionContext, CONTEXT)
  assert.throws(() => parseWorkerRpcRuntimeMessage({ ...message, type: 'WORKER_RPC' }))
  assert.throws(() =>
    parseKeyringWorkerRpcRuntimeMessage({ ...message, method: 'wallet.getBalance' })
  )
})
