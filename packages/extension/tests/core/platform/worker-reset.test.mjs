import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZcashWorkerClient } from '../../../src/core/worker/client.ts'

// Reset must reach an offscreen runtime even when this client never initialized it.
test('forced strict reset propagates failure, preserves retry state, and clears it after success', async () => {
  const client = Object.create(ZcashWorkerClient.prototype)
  const failure = new Error('Offscreen reset failed')
  let attempts = 0
  let aborted = 0
  let readinessReset = 0
  client.walletId = 'wallet-a'
  client.isInitialized = false
  client.dbKey = 'mainnet_wallet-a'
  client.dbBytes = new Uint8Array([1])
  client.initDedup = {
    abort() {
      aborted++
    }
  }
  client.accountReady = {
    reset() {
      readinessReset++
    }
  }
  client.request = async (method, payload) => {
    assert.equal(method, 'wallet.reset')
    assert.deepEqual(payload, { walletId: 'wallet-a' })
    if (++attempts === 1) throw failure
    return true
  }

  await assert.rejects(client.reset({ force: true, strict: true }), error => error === failure)
  assert.equal(client.dbKey, 'mainnet_wallet-a')
  assert.deepEqual([...client.dbBytes], [1])
  assert.equal(aborted, 0)
  assert.equal(readinessReset, 0)

  await client.reset({ force: true, strict: true })
  assert.equal(attempts, 2)
  assert.equal(client.dbKey, undefined)
  assert.equal(client.dbBytes, undefined)
  assert.equal(aborted, 1)
  assert.equal(readinessReset, 1)
})
