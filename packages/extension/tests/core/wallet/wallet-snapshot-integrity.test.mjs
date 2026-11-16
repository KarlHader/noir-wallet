import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeConnection, inspectWalletDbEntry, saveWalletDb } from '../../../src/lib/indexed-db.ts'

test('wallet snapshots require real, nonempty bytes and consistent positive chunks', async () => {
  const metadata = { version: 1 }
  assert.equal(inspectWalletDbEntry({ metadata, data: new Uint8Array([1]) }).status, 'compatible')
  assert.equal(inspectWalletDbEntry({ metadata, data: new ArrayBuffer(1) }).status, 'compatible')
  for (const data of [new Uint8Array(), new ArrayBuffer(0), { byteLength: 1 }, [1]]) {
    assert.equal(inspectWalletDbEntry({ metadata, data }).status, 'incompatible')
  }
  const manifest = { metadata, chunked: true, chunkCount: 2, chunkSizes: [2, 3], totalBytes: 5 }
  assert.equal(inspectWalletDbEntry(manifest).status, 'compatible')
  for (const invalid of [
    { chunkCount: 0, chunkSizes: [], totalBytes: 0 },
    { chunkSizes: [0, 5] },
    { chunkSizes: [2, 2] },
    { chunkCount: 3 },
    { totalBytes: -5 }
  ]) {
    assert.equal(inspectWalletDbEntry({ ...manifest, ...invalid }).status, 'incompatible')
  }
  // Rejection precedes opening IndexedDB, so invalid serialization cannot delete a good snapshot.
  for (const bytes of [[], [new Uint8Array()], [new Uint8Array([1]), new Uint8Array()]]) {
    await assert.rejects(saveWalletDb('mainnet_fixture', bytes), /empty|serialize|invalid/i)
  }
})

for (const quarantineField of ['snapshotQuarantined', 'journalQuarantined']) {
  test(`${quarantineField} committed after preflight prevents snapshot replacement`, async t => {
    const originalIndexedDb = globalThis.indexedDB
    const key = 'mainnet_fixture'
    const original = { metadata: { version: 1 }, data: new Uint8Array([1, 2, 3]) }
    const snapshots = new Map([[key, original]])
    const quarantine = new Map()
    let writes = 0
    globalThis.indexedDB = {
      open() {
        const request = {}
        queueMicrotask(() => {
          request.result = {
            close() {},
            transaction(_stores, mode) {
              if (mode === 'readwrite') {
                quarantine.set(key, {
                  schemaVersion: 1,
                  key,
                  network: 'mainnet',
                  walletId: 'fixture',
                  snapshotQuarantined: quarantineField === 'snapshotQuarantined',
                  journalQuarantined: quarantineField === 'journalQuarantined',
                  detectedAt: Date.now(),
                  reasons: ['wasm-restore-rejected']
                })
              }
              const transaction = {
                error: null,
                abort() {
                  queueMicrotask(() => transaction.onabort?.())
                },
                objectStore(name) {
                  return {
                    get(recordKey) {
                      const result = {}
                      queueMicrotask(() => {
                        result.result = (name === 'walletData' ? snapshots : quarantine).get(
                          recordKey
                        )
                        result.onsuccess?.()
                      })
                      return result
                    },
                    put() {
                      writes++
                    },
                    delete() {
                      writes++
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
    t.after(() => {
      closeConnection()
      globalThis.indexedDB = originalIndexedDb
    })

    await assert.rejects(saveWalletDb(key, new Uint8Array([4, 5])), /quarantined/)
    assert.equal(writes, 0)
    assert.equal(snapshots.get(key), original)
  })
}
