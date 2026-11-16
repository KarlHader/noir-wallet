import { expect, test } from '../helpers/extension-fixtures'

test('quarantines a rejected snapshot without deleting snapshot or journal', async ({ popup }) => {
  const walletId = `quarantine-${crypto.randomUUID()}`
  const network = 'mainnet'
  const dbKey = `${network}_${walletId}`

  const result = await popup.evaluate(
    async ({ walletId, network, dbKey }) => {
      const init = () =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'init',
          payload: {
            walletId,
            network,
            lightwalletdUrl: 'https://zcash-wallet-grpc-self.deltarpc.com',
            dbKey
          }
        })
      const initializeWallet = async () => {
        let resolveReady: (() => void) | undefined
        let rejectReady: ((error: Error) => void) | undefined
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve
          rejectReady = reject
        })
        const listener = (message: { type?: string }) => {
          if (message.type === 'OFFSCREEN_READY') resolveReady?.()
        }
        chrome.runtime.onMessage.addListener(listener)
        const timeoutId = setTimeout(() => {
          rejectReady?.(new Error('Timed out waiting for the offscreen worker host'))
        }, 5_000)

        try {
          let response = await init()
          if (!response) {
            await ready
            response = await init()
          }
          if (!response) throw new Error('init: offscreen did not respond after ready signal')
          if (response.error) throw new Error(`init: ${response.error}`)
          if (response.result !== true && response.result !== 'empty') {
            throw new Error(`init: unexpected result ${String(response.result)}`)
          }
          return response
        } finally {
          clearTimeout(timeoutId)
          chrome.runtime.onMessage.removeListener(listener)
        }
      }
      const bootstrapResponse = await initializeWallet()

      const openDb = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('zcash-wallet-db')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const db = await openDb()
      const requiredStores = [
        'walletData',
        'syncJournal',
        'syncJournalManifest',
        'walletPersistenceQuarantine'
      ]
      const missingStores = requiredStores.filter(store => !db.objectStoreNames.contains(store))
      if (missingStores.length > 0) {
        throw new Error(
          JSON.stringify({
            bootstrapResponse,
            databaseVersion: db.version,
            stores: Array.from(db.objectStoreNames),
            missingStores
          })
        )
      }
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          ['walletData', 'syncJournal', 'syncJournalManifest'],
          'readwrite'
        )
        transaction.objectStore('walletData').put(
          {
            metadata: {
              version: 1,
              timestamp: Date.now(),
              network,
              walletId
            },
            data: new Uint8Array([1, 2, 3, 4])
          },
          dbKey
        )
        transaction.objectStore('syncJournal').put({
          walletKey: dbKey,
          seq: 0,
          rangeStart: 3_000_000,
          rangeEnd: 3_000_001,
          data: new Uint8Array([5, 6, 7]),
          committedAt: Date.now()
        })
        transaction.objectStore('syncJournalManifest').put(
          {
            walletKey: dbKey,
            baseSnapshotSeq: 0,
            nextSeq: 1,
            totalBytes: 3,
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          dbKey
        )
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      db.close()

      await chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'wallet.reload',
        payload: {
          walletId,
          network,
          lightwalletdUrl: 'https://zcash-wallet-grpc-self.deltarpc.com',
          dbKey,
          recreateWorker: true
        }
      })
      await initializeWallet()

      const verifyDb = await openDb()
      const retained = await new Promise<{
        snapshot: boolean
        journalCount: number
        manifest: boolean
        quarantine: unknown
      }>((resolve, reject) => {
        const transaction = verifyDb.transaction(
          ['walletData', 'syncJournal', 'syncJournalManifest', 'walletPersistenceQuarantine'],
          'readonly'
        )
        const snapshotRequest = transaction.objectStore('walletData').get(dbKey)
        const journalRequest = transaction
          .objectStore('syncJournal')
          .index('byWallet')
          .count(IDBKeyRange.only(dbKey))
        const manifestRequest = transaction.objectStore('syncJournalManifest').get(dbKey)
        const quarantineRequest = transaction.objectStore('walletPersistenceQuarantine').get(dbKey)
        transaction.oncomplete = () =>
          resolve({
            snapshot: snapshotRequest.result !== undefined,
            journalCount: journalRequest.result,
            manifest: manifestRequest.result !== undefined,
            quarantine: quarantineRequest.result
          })
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      verifyDb.close()
      return retained
    },
    { walletId, network, dbKey }
  )

  expect(result).toMatchObject({
    snapshot: true,
    journalCount: 1,
    manifest: true,
    quarantine: {
      schemaVersion: 1,
      key: dbKey,
      network,
      walletId,
      snapshotQuarantined: true,
      journalQuarantined: true,
      reasons: ['wasm-restore-rejected']
    }
  })
})
