import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeConnection,
  loadTransparentTxCache,
  mutateTransactions,
  saveTransparentTxCache
} from '../../../src/lib/indexed-db.ts'

function transactionDatabase() {
  const records = new Map()
  let queue = Promise.resolve()
  return {
    records,
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            let active = false
            const transaction = {
              error: null,
              objectStore() {
                return {
                  get(key) {
                    const result = {}
                    queue = queue.then(() => {
                      active = true
                      result.result = records.get(key)
                      result.onsuccess?.()
                      active = false
                      transaction.oncomplete?.()
                    })
                    return result
                  },
                  put(value, key) {
                    if (active) records.set(key, value)
                    else {
                      queue = queue.then(() => {
                        records.set(key, value)
                        transaction.oncomplete?.()
                      })
                    }
                  }
                }
              }
            }
            return transaction
          }
        }
        request.onsuccess?.()
      })
      return request
    }
  }
}

test('concurrent transparent history and recipient writes retain both bodies', async t => {
  const originalIndexedDb = globalThis.indexedDB
  const database = transactionDatabase()
  globalThis.indexedDB = database
  t.after(() => {
    closeConnection()
    globalThis.indexedDB = originalIndexedDb
  })

  const existingHash = '11'.repeat(32)
  const receiveHash = '22'.repeat(32)
  const recipientHash = '33'.repeat(32)
  const body = txid => ({ txid, confirmations: 4, vout: [] })
  const key = 'mainnet_wallet_account'
  await saveTransparentTxCache(key, new Map([[existingHash, body(existingHash)]]))
  await Promise.all([
    saveTransparentTxCache(key, new Map([[receiveHash, body(receiveHash)]])),
    saveTransparentTxCache(key, new Map([[recipientHash, body(recipientHash)]]))
  ])

  assert.deepEqual(await loadTransparentTxCache(key), {
    [existingHash]: body(existingHash),
    [receiveHash]: body(receiveHash),
    [recipientHash]: body(recipientHash)
  })
})

test('cancelling after the transaction updater runs prevents its IDB commit', async t => {
  const originalIndexedDb = globalThis.indexedDB
  const key = 'mainnet_wallet_account'
  const original = [{ id: 'send', type: 'send', to: '' }]
  const records = new Map([[key, original]])
  let notifyPut
  const putReached = new Promise(resolve => {
    notifyPut = resolve
  })
  const database = {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            let aborted = false
            const transaction = {
              error: null,
              abort() {
                if (aborted) return
                aborted = true
                queueMicrotask(() => transaction.onabort?.())
              },
              objectStore() {
                return {
                  get(transactionKey) {
                    const getRequest = {}
                    queueMicrotask(() => {
                      if (aborted) return
                      getRequest.result = records.get(transactionKey)
                      getRequest.onsuccess?.()
                    })
                    return getRequest
                  },
                  put(value, transactionKey) {
                    notifyPut()
                    queueMicrotask(() => {
                      if (aborted) return
                      records.set(transactionKey, value)
                      transaction.oncomplete?.()
                    })
                  }
                }
              }
            }
            return transaction
          }
        }
        request.onsuccess?.()
      })
      return request
    }
  }
  globalThis.indexedDB = database
  t.after(() => {
    closeConnection()
    globalThis.indexedDB = originalIndexedDb
  })

  const controller = new AbortController()
  const reason = new DOMException('Account switched', 'AbortError')
  let updaterRan = false
  const pending = mutateTransactions(
    key,
    transactions => {
      updaterRan = true
      return transactions.map(transaction => ({ ...transaction, to: 't1Recovered' }))
    },
    controller.signal
  )
  await putReached
  assert.equal(updaterRan, true)
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.deepEqual(records.get(key), original)
})
