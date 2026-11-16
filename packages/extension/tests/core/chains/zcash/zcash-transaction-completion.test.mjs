import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForZcashTxCompleted } from '../../../../src/popup/services/zcash-transaction-completion.ts'
import { TimeoutError } from '../../../../src/lib/async-utils.ts'

test('transaction dispatch handles rejection, scope, final completion, and cleanup', async t => {
  const listeners = new Set()
  const previousChrome = globalThis.chrome
  globalThis.chrome = {
    runtime: {
      id: 'synthetic',
      onMessage: {
        addListener: listener => listeners.add(listener),
        removeListener: listener => listeners.delete(listener)
      }
    }
  }
  t.after(() => {
    globalThis.chrome = previousChrome
  })
  const sender = { id: 'synthetic', url: 'chrome-extension://synthetic/service-worker-loader.js' }
  const complete = (overrides = {}, source = sender) => {
    for (const listener of listeners)
      listener(
        {
          type: 'ZCASH_TX_COMPLETED',
          accountKey: 'account',
          transactionId: 'operation',
          ...overrides
        },
        source
      )
  }
  const wait = dispatch => waitForZcashTxCompleted('account', 'operation', 1000, dispatch)

  await t.test('resolved backend error rejects immediately and removes listeners', async () => {
    await assert.rejects(
      wait(async () => ({ error: 'Wallet network initialization failed' })),
      /Wallet network initialization failed/
    )
    assert.equal(listeners.size, 0)
  })
  await t.test('synchronous dispatcher failure is handled', async () => {
    await assert.rejects(
      wait(() => {
        throw new Error('channel closed')
      }),
      /channel closed/
    )
    assert.equal(listeners.size, 0)
  })
  await t.test(
    'ACK does not complete and unrelated messages cannot satisfy the request',
    async () => {
      let settled = false
      const pending = wait(async () => ({ success: true })).then(value => {
        settled = true
        return value
      })
      await Promise.resolve()
      complete({ txHash: 'wrong', transactionId: 'other' })
      complete({ txHash: 'wrong' }, { id: 'foreign', url: sender.url })
      await Promise.resolve()
      assert.equal(settled, false)
      complete({ txHash: 'original-hash' })
      assert.deepEqual(await pending, { txHash: 'original-hash' })
      assert.equal(listeners.size, 0)
    }
  )
  await t.test('an unknown outcome stays distinguishable from a definitive failure', async () => {
    const pending = wait(async () => ({ success: true }))
    complete({ error: 'Submission pending', completionPending: true })
    await assert.rejects(pending, error => error instanceof TimeoutError)
    assert.equal(listeners.size, 0)
  })
})
